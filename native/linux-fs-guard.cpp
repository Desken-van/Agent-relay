/**
 * Linux counterpart of `native/windows-fs-guard.cpp`: the same narrowly
 * scoped, fixed-protocol helper that performs exactly one bounded filesystem
 * mutation (create / replace / delete a regular file, or create missing
 * directory components) inside an Ornith task worktree, binding every step to
 * already-open file descriptors instead of re-resolving an attacker-swappable
 * pathname at the moment of the mutation.
 *
 * Linux has the primitive Windows lacks publicly: every `*at()` system call
 * resolves its name relative to an already-open directory descriptor. Each
 * path component is opened with `openat(parent, name, O_DIRECTORY |
 * O_NOFOLLOW)`, so a symlink is refused rather than followed, and a rename or
 * replacement of an ancestor after it was opened cannot redirect anything
 * opened relative to that descriptor. Every opened directory must also stay on
 * the root's device and mount, so a bind mount or other mount point inside the
 * worktree is refused the way a junction is on Windows.
 *
 * Protocol (identical argv and stdout to the Windows helper, so the
 * TypeScript side shares one parser):
 *
 *   agent-relay-fs-guard identity <root>
 *   agent-relay-fs-guard mkdirp   <root> <volumeId> <fileId128> <relDir>
 *   agent-relay-fs-guard create   <root> <volumeId> <fileId128> <relPath>          (content on stdin)
 *   agent-relay-fs-guard replace  <root> <volumeId> <fileId128> <targetDev> <targetIno> <relPath> <sha256> (content on stdin)
 *   agent-relay-fs-guard delete   <root> <volumeId> <fileId128> <targetDev> <targetIno> <relPath> <sha256>
 *
 * On Linux the root identity is: `volumeId` = the device number as Node's
 * `fs.Stats.dev` reports it (`makedev(stx_dev_major, stx_dev_minor)`), in 16
 * hex digits; `fileId128` = the inode number (16 hex digits) followed by the
 * inode birth time (16 hex digits, zero when the filesystem does not record
 * one), so a directory recreated at the same pathname that happens to reuse
 * the inode number is still a different root. `identity` additionally prints
 * the decimal device and inode, which the caller correlates with its own
 * `lstat` snapshot taken before any model-driven work. `targetDev`/`targetIno`
 * are the decimal `fs.Stats.dev`/`ino` of the file the caller hashed.
 *
 * New content is read from the private one-shot stdin pipe and staged in an
 * anonymous `O_TMPFILE` inode in the destination's own directory, so a helper
 * killed mid-write leaves nothing behind and nothing partial is ever visible
 * at the destination: the destination name only ever points at the old file
 * or at the complete new one.
 *
 *  - create links the staged inode to the destination without replacing
 *    anything (`linkat` fails if the name exists).
 *  - replace verifies the target's identity and SHA-256 through an open
 *    descriptor, atomically exchanges the staged file with it
 *    (`renameat2(RENAME_EXCHANGE)`), then verifies that what it swapped out is
 *    still that same, unchanged inode — and exchanges back if not. The file's
 *    permission bits are carried over, so an executable script stays
 *    executable.
 *  - delete verifies the same way, atomically moves the target to a private
 *    quarantine name (`renameat2(RENAME_NOREPLACE)`), re-verifies what it
 *    moved, restores it if it was swapped in the meantime, and only then
 *    unlinks it.
 *
 * Filesystems without `O_TMPFILE`, `RENAME_EXCHANGE` or `RENAME_NOREPLACE`
 * (some network and FUSE filesystems) take a portable path: a named
 * `O_CREAT | O_EXCL | O_NOFOLLOW` staging file in the same directory, and a
 * verify-then-rename with the same small window the Windows helper has. The
 * environment variable `AGENT_RELAY_FS_GUARD_PORTABLE_ONLY=1` forces that
 * path so tests can prove it; it never disables a check, and the application
 * never passes it on to the helper.
 *
 * Termination signals are blocked from the moment staging starts until the
 * process exits. A timeout or cancellation that arrives before the commit
 * abandons the operation (nothing changed); one that arrives during or after
 * the commit lets it finish and still report `OK`, so a change that landed is
 * never reported as a failure, and the multi-step commit is never torn in
 * half. Only SIGKILL (five seconds later) can interrupt the helper, and an
 * anonymous staging inode leaves nothing behind even then.
 *
 * `relPath`/`relDir` are POSIX-style, `/`-separated, relative to `root`; every
 * segment is re-validated here from scratch — the caller's own validation is
 * never trusted alone.
 *
 * Exactly one line is printed to stdout: `OK` (or `OK:<identity>`) on
 * success, or `ERR:<CODE>` on a recognised, closed-vocabulary failure. Exit
 * code 0 means `OK`; 1 means a recognised `ERR`; 2 means an
 * internal/unexpected failure. Diagnostics may go to stderr and are never
 * parsed.
 */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <fcntl.h>
#include <signal.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace {

/* -------------------------------------------------------------------------- */
/* Result vocabulary (identical to the Windows helper)                        */
/* -------------------------------------------------------------------------- */

enum class GuardError {
  kReparseAncestor,
  kNotDirectory,
  kNotFound,
  kAlreadyExists,
  kHashMismatch,
  kHardLinked,
  kNotAFile,
  kRootInvalid,
  kInvalidArguments,
  kInternal
};

const char* codeName(GuardError error) {
  switch (error) {
    case GuardError::kReparseAncestor: return "REPARSE_ANCESTOR";
    case GuardError::kNotDirectory: return "NOT_DIRECTORY";
    case GuardError::kNotFound: return "NOT_FOUND";
    case GuardError::kAlreadyExists: return "ALREADY_EXISTS";
    case GuardError::kHashMismatch: return "HASH_MISMATCH";
    case GuardError::kHardLinked: return "HARD_LINKED";
    case GuardError::kNotAFile: return "NOT_A_FILE";
    case GuardError::kRootInvalid: return "ROOT_INVALID";
    case GuardError::kInvalidArguments: return "INVALID_ARGUMENTS";
    default: return "INTERNAL";
  }
}

/** Thrown internally to unwind straight to one fixed error report. */
struct GuardFailure {
  GuardError error;
};

[[noreturn]] void fail(GuardError error) { throw GuardFailure{error}; }

/** stderr only; never parsed. Never includes file content. */
void diagnose(const char* what, int error) {
  std::fprintf(stderr, "agent-relay-fs-guard: %s (errno=%d)\n", what, error);
}

struct Fd {
  int value = -1;
  Fd() = default;
  explicit Fd(int fd) : value(fd) {}
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  Fd(Fd&& other) noexcept : value(other.value) { other.value = -1; }
  Fd& operator=(Fd&& other) noexcept {
    if (this != &other) {
      reset();
      value = other.value;
      other.value = -1;
    }
    return *this;
  }
  ~Fd() { reset(); }
  void reset() {
    if (value >= 0) close(value);
    value = -1;
  }
};

bool portableOnly() {
  const char* value = std::getenv("AGENT_RELAY_FS_GUARD_PORTABLE_ONLY");
  return value != nullptr && std::strcmp(value, "1") == 0;
}

/** errno values a kernel/filesystem uses to say "this flag is not supported here". */
bool unsupported(int error) {
  return error == EINVAL || error == ENOSYS || error == EOPNOTSUPP;
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

struct FileInfo {
  uint64_t dev = 0;
  uint64_t ino = 0;
  /** (birth seconds << 30) | birth nanoseconds, or 0 when not recorded. */
  uint64_t birth = 0;
  bool hasMountId = false;
  uint64_t mountId = 0;
  mode_t mode = 0;
  uint64_t nlink = 0;
  uint64_t size = 0;
};

FileInfo fromStatx(const struct statx& value) {
  FileInfo info;
  // Exactly what libuv (and so Node's fs.Stats.dev) reports on Linux.
  info.dev = static_cast<uint64_t>(makedev(value.stx_dev_major, value.stx_dev_minor));
  info.ino = value.stx_ino;
  if ((value.stx_mask & STATX_BTIME) != 0 && value.stx_btime.tv_sec >= 0) {
    info.birth = (static_cast<uint64_t>(value.stx_btime.tv_sec) << 30) |
        (static_cast<uint64_t>(value.stx_btime.tv_nsec) & 0x3fffffffULL);
  }
  if ((value.stx_mask & STATX_MNT_ID) != 0) {
    info.hasMountId = true;
    info.mountId = value.stx_mnt_id;
  }
  info.mode = value.stx_mode;
  info.nlink = value.stx_nlink;
  info.size = value.stx_size;
  return info;
}

/** statx of `name` relative to `dirFd` (or of `dirFd` itself when name is ""), never following a symlink. */
bool statAt(int dirFd, const char* name, FileInfo& out, int& error) {
  struct statx value {};
  const int flags = AT_SYMLINK_NOFOLLOW | AT_STATX_SYNC_AS_STAT | (name[0] == '\0' ? AT_EMPTY_PATH : 0);
  if (statx(dirFd, name, flags, STATX_BASIC_STATS | STATX_BTIME | STATX_MNT_ID, &value) != 0) {
    error = errno;
    if (error != ENOSYS && error != EPERM) return false;
    // A seccomp profile that denies statx: fstatat gives the same device and
    // inode Node falls back to, without birth time or mount id.
    struct stat plain {};
    if (fstatat(dirFd, name, &plain, AT_SYMLINK_NOFOLLOW | (name[0] == '\0' ? AT_EMPTY_PATH : 0)) != 0) {
      error = errno;
      return false;
    }
    out = FileInfo{};
    out.dev = static_cast<uint64_t>(plain.st_dev);
    out.ino = static_cast<uint64_t>(plain.st_ino);
    out.mode = plain.st_mode;
    out.nlink = static_cast<uint64_t>(plain.st_nlink);
    out.size = plain.st_size < 0 ? 0 : static_cast<uint64_t>(plain.st_size);
    return true;
  }
  if ((value.stx_mask & (STATX_TYPE | STATX_MODE | STATX_INO | STATX_NLINK | STATX_SIZE)) !=
      (STATX_TYPE | STATX_MODE | STATX_INO | STATX_NLINK | STATX_SIZE)) {
    error = EIO;
    return false;
  }
  out = fromStatx(value);
  return true;
}

FileInfo infoOf(int fd) {
  FileInfo info;
  int error = 0;
  if (!statAt(fd, "", info, error)) {
    diagnose("statx failed", error);
    fail(GuardError::kInternal);
  }
  return info;
}

struct RootIdentity {
  uint64_t dev = 0;
  uint64_t ino = 0;
  uint64_t birth = 0;
};

int hexNibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

uint64_t parseHex64(const char* value, size_t length) {
  if (length != 16) fail(GuardError::kInvalidArguments);
  uint64_t result = 0;
  for (size_t index = 0; index < length; ++index) {
    const int nibble = hexNibble(value[index]);
    if (nibble < 0) fail(GuardError::kInvalidArguments);
    result = (result << 4) | static_cast<uint64_t>(nibble);
  }
  return result;
}

RootIdentity expectedRootIdentity(const std::string& volumeId, const std::string& fileId) {
  if (fileId.size() != 32) fail(GuardError::kInvalidArguments);
  RootIdentity identity;
  identity.dev = parseHex64(volumeId.data(), volumeId.size());
  identity.ino = parseHex64(fileId.data(), 16);
  identity.birth = parseHex64(fileId.data() + 16, 16);
  return identity;
}

uint64_t parseDecimal64(const std::string& value) {
  if (value.empty()) fail(GuardError::kInvalidArguments);
  uint64_t result = 0;
  for (char character : value) {
    if (character < '0' || character > '9') fail(GuardError::kInvalidArguments);
    const uint64_t digit = static_cast<uint64_t>(character - '0');
    if (result > (std::numeric_limits<uint64_t>::max() - digit) / 10) {
      fail(GuardError::kInvalidArguments);
    }
    result = result * 10 + digit;
  }
  return result;
}

std::string validateSha256(const std::string& value) {
  if (value.size() != 64) fail(GuardError::kInvalidArguments);
  std::string lower;
  lower.reserve(64);
  for (char character : value) {
    const int nibble = hexNibble(character);
    if (nibble < 0) fail(GuardError::kInvalidArguments);
    lower.push_back("0123456789abcdef"[nibble]);
  }
  return lower;
}

/* -------------------------------------------------------------------------- */
/* Path-component validation (independent of, never trusting, the caller's)   */
/* -------------------------------------------------------------------------- */

std::vector<std::string> splitAndValidate(const std::string& relative) {
  std::vector<std::string> segments;
  if (relative.empty()) return segments;

  std::string current;
  auto flush = [&]() {
    if (current.empty() || current == "." || current == "..") fail(GuardError::kInvalidArguments);
    // A backslash is never part of a normalized repository-relative path.
    if (current.find('\\') != std::string::npos) fail(GuardError::kInvalidArguments);
    for (char ch : current) {
      const unsigned char byte = static_cast<unsigned char>(ch);
      if (byte <= 0x1f || byte == 0x7f) fail(GuardError::kInvalidArguments);
    }
    if (current.size() > NAME_MAX) fail(GuardError::kInvalidArguments);
    if (current == ".git") fail(GuardError::kInvalidArguments);
    segments.push_back(current);
    current.clear();
  };

  for (char ch : relative) {
    if (ch == '/') {
      flush();
    } else {
      current.push_back(ch);
    }
  }
  flush();
  return segments;
}

/* -------------------------------------------------------------------------- */
/* Descriptor-relative directory/file walk                                    */
/* -------------------------------------------------------------------------- */

struct Root {
  Fd fd;
  FileInfo info;
};

/**
 * Open `root` itself. Refuses a relative path, a symlink, a non-directory, and
 * (when `expected` is given) any directory other than the one whose identity
 * was captured for this Ornith run.
 */
Root openRoot(const std::string& root, const RootIdentity* expected) {
  if (root.empty() || root[0] != '/') fail(GuardError::kInvalidArguments);
  const int fd = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail(GuardError::kRootInvalid);
  Root result{Fd(fd), FileInfo{}};
  int error = 0;
  if (!statAt(result.fd.value, "", result.info, error)) fail(GuardError::kRootInvalid);
  if (!S_ISDIR(result.info.mode)) fail(GuardError::kRootInvalid);
  if (expected != nullptr &&
      (result.info.dev != expected->dev || result.info.ino != expected->ino ||
       result.info.birth != expected->birth)) {
    fail(GuardError::kRootInvalid);
  }
  return result;
}

/** A symlink at `name` is an ancestor/target substitution; anything else that is not a directory is not. */
GuardError classifyNonDirectory(int parent, const char* name) {
  FileInfo info;
  int error = 0;
  if (!statAt(parent, name, info, error)) return error == ENOENT ? GuardError::kNotFound : GuardError::kNotDirectory;
  return S_ISLNK(info.mode) ? GuardError::kReparseAncestor : GuardError::kNotDirectory;
}

/** Objects opened below the root must stay on its filesystem and mount: no mount point is crossed. */
void assertSameMount(const FileInfo& info, const FileInfo& root) {
  if (info.dev != root.dev) fail(GuardError::kReparseAncestor);
  if (info.hasMountId && root.hasMountId && info.mountId != root.mountId) {
    fail(GuardError::kReparseAncestor);
  }
}

/**
 * Open (or, if `createIfMissing`, create) exactly one directory component
 * relative to `parent`, never re-resolving anything by absolute path and never
 * following a symlink.
 */
Fd openOrCreateChildDirectory(int parent, const std::string& name, bool createIfMissing, const FileInfo& root) {
  for (int attempt = 0; attempt < 4; ++attempt) {
    const int fd = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd >= 0) {
      Fd guard(fd);
      const FileInfo info = infoOf(guard.value);
      if (!S_ISDIR(info.mode)) fail(GuardError::kNotDirectory);
      assertSameMount(info, root);
      return guard;
    }
    const int error = errno;
    if (error == ENOENT) {
      if (!createIfMissing) fail(GuardError::kNotFound);
      // Mode 0777 is filtered by the process umask, exactly like Node's mkdir.
      if (mkdirat(parent, name.c_str(), 0777) == 0 || errno == EEXIST) continue;
      if (errno == ENOENT) fail(GuardError::kNotFound);
      diagnose("mkdirat refused", errno);
      fail(GuardError::kInternal);
    }
    if (error == ENOTDIR || error == ELOOP) fail(classifyNonDirectory(parent, name.c_str()));
    if (error == ENAMETOOLONG) fail(GuardError::kInvalidArguments);
    diagnose("openat(directory) refused", error);
    fail(GuardError::kInternal);
  }
  // Something kept removing the directory between mkdirat and openat.
  fail(GuardError::kInternal);
}

/** Walk (and optionally create) every segment relative to the root descriptor. */
Fd walkDirectories(const Root& root, const std::vector<std::string>& segments, bool createIfMissing) {
  Fd current(fcntl(root.fd.value, F_DUPFD_CLOEXEC, 0));
  if (current.value < 0) fail(GuardError::kInternal);
  for (const auto& segment : segments) {
    current = openOrCreateChildDirectory(current.value, segment, createIfMissing, root.info);
  }
  return current;
}

struct OpenedTarget {
  Fd fd;
  FileInfo info;
};

/**
 * Open an existing final file component relative to `parent` for reading.
 * Never follows a symlink; never opens a FIFO, socket or device (they are
 * refused from their type before opening, and the opened descriptor's own
 * type is checked again); refuses a directory and a hard-linked file.
 */
OpenedTarget openExistingRegularFile(int parent, const std::string& name, const FileInfo& root) {
  FileInfo before;
  int error = 0;
  if (!statAt(parent, name.c_str(), before, error)) {
    if (error == ENOENT) fail(GuardError::kNotFound);
    if (error == ENAMETOOLONG) fail(GuardError::kInvalidArguments);
    diagnose("statx(target) refused", error);
    fail(GuardError::kInternal);
  }
  if (S_ISLNK(before.mode)) fail(GuardError::kReparseAncestor);
  if (!S_ISREG(before.mode)) fail(GuardError::kNotAFile);

  const int fd = openat(parent, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
  if (fd < 0) {
    error = errno;
    if (error == ENOENT) fail(GuardError::kNotFound);
    if (error == ELOOP) fail(GuardError::kReparseAncestor);
    if (error == ENXIO || error == EISDIR) fail(GuardError::kNotAFile);
    diagnose("openat(target) refused", error);
    fail(GuardError::kInternal);
  }
  OpenedTarget target{Fd(fd), FileInfo{}};
  target.info = infoOf(target.fd.value);
  if (!S_ISREG(target.info.mode)) fail(GuardError::kNotAFile);
  assertSameMount(target.info, root);
  if (target.info.nlink > 1) fail(GuardError::kHardLinked);
  return target;
}

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

// Same ceiling ORNITH_LIMITS.maxFileBytes enforces before this helper is ever
// invoked; re-asserted here so this process never allocates an unbounded
// buffer no matter what called it.
constexpr size_t kMaxContentBytes = 8 * 1024 * 1024;

std::vector<unsigned char> readBoundedStdin() {
  std::vector<unsigned char> content;
  std::array<unsigned char, 64 * 1024> chunk{};
  for (;;) {
    const ssize_t read = ::read(STDIN_FILENO, chunk.data(), chunk.size());
    if (read < 0) {
      if (errno == EINTR) continue;
      diagnose("reading stdin failed", errno);
      fail(GuardError::kInternal);
    }
    if (read == 0) break;
    if (content.size() + static_cast<size_t>(read) > kMaxContentBytes) {
      fail(GuardError::kInvalidArguments);
    }
    content.insert(content.end(), chunk.begin(), chunk.begin() + read);
  }
  return content;
}

void writeAll(int fd, const std::vector<unsigned char>& content) {
  size_t written = 0;
  while (written < content.size()) {
    const ssize_t chunk = ::write(fd, content.data() + written, content.size() - written);
    if (chunk < 0) {
      if (errno == EINTR) continue;
      diagnose("writing staged content failed", errno);
      fail(GuardError::kInternal);
    }
    if (chunk == 0) fail(GuardError::kInternal);
    written += static_cast<size_t>(chunk);
  }
  if (fsync(fd) != 0) {
    diagnose("fsync(staged) failed", errno);
    fail(GuardError::kInternal);
  }
}

/* SHA-256 (FIPS 180-4), self-contained so the helper needs no crypto library. */
class Sha256 {
 public:
  Sha256() { state_ = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19}; }

  void update(const unsigned char* data, size_t length) {
    for (size_t index = 0; index < length; ++index) {
      block_[blockLength_++] = data[index];
      if (blockLength_ == 64) {
        transform();
        blockLength_ = 0;
      }
    }
    totalBytes_ += length;
  }

  std::string hexDigest() {
    const uint64_t bitLength = totalBytes_ * 8;
    const unsigned char pad = 0x80;
    update(&pad, 1);
    const unsigned char zero = 0;
    while (blockLength_ != 56) update(&zero, 1);
    unsigned char lengthBytes[8];
    for (int index = 0; index < 8; ++index) {
      lengthBytes[index] = static_cast<unsigned char>(bitLength >> (56 - 8 * index));
    }
    update(lengthBytes, 8);
    static const char* kHex = "0123456789abcdef";
    std::string hex;
    hex.reserve(64);
    for (uint32_t word : state_) {
      for (int shift = 28; shift >= 0; shift -= 4) hex.push_back(kHex[(word >> shift) & 0xf]);
    }
    return hex;
  }

 private:
  static uint32_t rotr(uint32_t value, int count) { return (value >> count) | (value << (32 - count)); }

  void transform() {
    static const uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int index = 0; index < 16; ++index) {
      w[index] = (static_cast<uint32_t>(block_[index * 4]) << 24) |
          (static_cast<uint32_t>(block_[index * 4 + 1]) << 16) |
          (static_cast<uint32_t>(block_[index * 4 + 2]) << 8) |
          static_cast<uint32_t>(block_[index * 4 + 3]);
    }
    for (int index = 16; index < 64; ++index) {
      const uint32_t s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >> 3);
      const uint32_t s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >> 10);
      w[index] = w[index - 16] + s0 + w[index - 7] + s1;
    }
    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (int index = 0; index < 64; ++index) {
      const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const uint32_t choice = (e & f) ^ (~e & g);
      const uint32_t temp1 = h + s1 + choice + k[index] + w[index];
      const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t temp2 = s0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }
    state_[0] += a; state_[1] += b; state_[2] += c; state_[3] += d;
    state_[4] += e; state_[5] += f; state_[6] += g; state_[7] += h;
  }

  std::array<uint32_t, 8> state_{};
  std::array<unsigned char, 64> block_{};
  size_t blockLength_ = 0;
  uint64_t totalBytes_ = 0;
};

/** SHA-256 of everything readable through `fd` right now, bounded like the Windows helper. */
std::string sha256HexOfFd(int fd) {
  const FileInfo info = infoOf(fd);
  if (info.size > kMaxContentBytes) fail(GuardError::kInternal);
  std::vector<unsigned char> buffer(static_cast<size_t>(info.size));
  size_t total = 0;
  while (total < buffer.size()) {
    const ssize_t chunk = pread(fd, buffer.data() + total, buffer.size() - total, static_cast<off_t>(total));
    if (chunk < 0) {
      if (errno == EINTR) continue;
      fail(GuardError::kInternal);
    }
    if (chunk == 0) break;
    total += static_cast<size_t>(chunk);
  }
  // Grown or shrunk since the size was read: not the content that was verified.
  if (total != buffer.size()) fail(GuardError::kHashMismatch);
  unsigned char extra = 0;
  ssize_t more;
  do {
    more = pread(fd, &extra, 1, static_cast<off_t>(total));
  } while (more < 0 && errno == EINTR);
  if (more != 0) fail(GuardError::kHashMismatch);
  Sha256 hash;
  hash.update(buffer.data(), buffer.size());
  return hash.hexDigest();
}

/** True when `fd` is still exactly the identity and content the caller hashed. */
bool sameVerifiedFile(int fd, uint64_t dev, uint64_t ino, const std::string& sha256) {
  const FileInfo info = infoOf(fd);
  if (info.dev != dev || info.ino != ino || !S_ISREG(info.mode)) return false;
  return sha256HexOfFd(fd) == sha256;
}

/**
 * The re-verification after a commit step: any failure to prove the file is
 * unchanged counts as changed, and never unwinds past the caller's restore.
 */
bool stillVerified(int fd, uint64_t dev, uint64_t ino, const std::string& sha256) noexcept {
  try {
    return sameVerifiedFile(fd, dev, ino, sha256);
  } catch (...) {
    return false;
  }
}

/** True when `name` under `parent` is, right now, the very inode open as `fd`. */
bool nameRefersTo(int parent, const std::string& name, const FileInfo& expected) {
  FileInfo info;
  int error = 0;
  if (!statAt(parent, name.c_str(), info, error)) return false;
  return info.dev == expected.dev && info.ino == expected.ino;
}

/* -------------------------------------------------------------------------- */
/* Staging and commit                                                          */
/* -------------------------------------------------------------------------- */

std::string randomTempName() {
  std::array<unsigned char, 12> random{};
  size_t filled = 0;
  while (filled < random.size()) {
    const ssize_t got = getrandom(random.data() + filled, random.size() - filled, 0);
    if (got < 0) {
      if (errno == EINTR) continue;
      fail(GuardError::kInternal);
    }
    filled += static_cast<size_t>(got);
  }
  static const char* kHex = "0123456789abcdef";
  std::string name = ".ornith-tmp-";
  for (unsigned char byte : random) {
    name.push_back(kHex[(byte >> 4) & 0xf]);
    name.push_back(kHex[byte & 0xf]);
  }
  return name;
}

/**
 * New content, fully written and flushed, not yet visible at its destination.
 * An anonymous O_TMPFILE inode disappears on its own if this process dies; a
 * named staging file (portable path, or after `materialize`) is removed by the
 * destructor unless the commit consumed it.
 */
struct StagedFile {
  int parent = -1;
  Fd fd;
  FileInfo info;
  std::string name;  // empty while anonymous
  bool committed = false;

  StagedFile() = default;
  StagedFile(const StagedFile&) = delete;
  StagedFile& operator=(const StagedFile&) = delete;
  ~StagedFile() {
    if (!committed && !name.empty() && nameRefersTo(parent, name, info)) {
      unlinkat(parent, name.c_str(), 0);
    }
  }
};

void stageContent(StagedFile& staged, int parent, const std::vector<unsigned char>& content) {
  staged.parent = parent;
  if (!portableOnly()) {
    // Mode 0666 is filtered by the process umask, exactly like Node's writeFile.
    const int fd = openat(parent, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0666);
    if (fd >= 0) {
      staged.fd = Fd(fd);
      writeAll(staged.fd.value, content);
      staged.info = infoOf(staged.fd.value);
      return;
    }
    if (!unsupported(errno) && errno != EISDIR) {
      diagnose("O_TMPFILE staging refused", errno);
      fail(GuardError::kInternal);
    }
  }
  for (int attempt = 0; attempt < 8; ++attempt) {
    const std::string name = randomTempName();
    const int fd = openat(parent, name.c_str(), O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
    if (fd < 0) {
      if (errno == EEXIST) continue;
      diagnose("named staging refused", errno);
      fail(GuardError::kInternal);
    }
    staged.fd = Fd(fd);
    staged.name = name;
    staged.info = infoOf(staged.fd.value);
    writeAll(staged.fd.value, content);
    return;
  }
  fail(GuardError::kInternal);
}

/**
 * Give the staged inode, through its open descriptor, the name `destination`
 * in its directory, failing with EEXIST (never replacing) if the name is
 * taken. Returns errno, 0 on success.
 */
int linkFromFd(const StagedFile& staged, const std::string& destination) {
  if (linkat(staged.fd.value, "", staged.parent, destination.c_str(), AT_EMPTY_PATH) == 0) return 0;
  const int direct = errno;
  if (direct == EEXIST) return EEXIST;
  // Older kernels reserve AT_EMPTY_PATH linking for CAP_DAC_READ_SEARCH; the
  // /proc magic link names the very same open inode.
  char path[64];
  std::snprintf(path, sizeof(path), "/proc/self/fd/%d", staged.fd.value);
  if (linkat(AT_FDCWD, path, staged.parent, destination.c_str(), AT_SYMLINK_FOLLOW) == 0) return 0;
  const int fallback = errno;
  // Without /proc the fallback's ENOENT says nothing about the destination.
  if (fallback == ENOENT && access("/proc/self/fd", F_OK) != 0) return EPERM;
  return fallback;
}

/** Give an anonymous staged file a private random name so it can take part in a rename. */
void materialize(StagedFile& staged) {
  if (!staged.name.empty()) return;
  for (int attempt = 0; attempt < 8; ++attempt) {
    const std::string name = randomTempName();
    const int error = linkFromFd(staged, name);
    if (error == 0) {
      staged.name = name;
      return;
    }
    if (error != EEXIST) {
      diagnose("linking the staged file refused", error);
      fail(GuardError::kInternal);
    }
  }
  fail(GuardError::kInternal);
}

sigset_t terminationSignals() {
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGTERM);
  sigaddset(&set, SIGINT);
  sigaddset(&set, SIGHUP);
  sigaddset(&set, SIGQUIT);
  return set;
}

/**
 * From here until the process exits, the termination signals a timeout or a
 * cancellation sends stay pending instead of killing the helper. They are
 * never unblocked again: the helper finishes, reports exactly what happened
 * (`OK` only when the change landed) and exits normally, so a change that
 * landed is never reported as a failure. Only SIGKILL, five seconds later,
 * still interrupts a helper stuck in the kernel.
 */
void deferTermination() {
  const sigset_t set = terminationSignals();
  if (sigprocmask(SIG_BLOCK, &set, nullptr) != 0) fail(GuardError::kInternal);
}

/**
 * Called immediately before the commit: a timeout or cancellation that arrived
 * while content was being staged abandons the operation before anything at
 * the destination changes.
 */
void abandonIfTerminationPending() {
  sigset_t pending;
  sigemptyset(&pending);
  if (sigpending(&pending) != 0) fail(GuardError::kInternal);
  const sigset_t set = terminationSignals();
  for (int signal : {SIGTERM, SIGINT, SIGHUP, SIGQUIT}) {
    if (sigismember(&set, signal) && sigismember(&pending, signal) == 1) {
      diagnose("abandoned before the commit: termination requested", 0);
      fail(GuardError::kInternal);
    }
  }
}

void syncDirectory(int directory) {
  // Durability of the new name; the change itself is already atomic.
  if (fsync(directory) != 0) diagnose("fsync(directory) failed", errno);
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

void doMkdirp(const std::string& rootPath, const RootIdentity& expected, const std::string& relDir) {
  const Root root = openRoot(rootPath, &expected);
  const auto segments = splitAndValidate(relDir);
  if (segments.empty()) return;
  walkDirectories(root, segments, true);
}

std::vector<std::string> parentSegmentsOf(const std::vector<std::string>& segments) {
  return std::vector<std::string>(segments.begin(), segments.end() - 1);
}

void doCreate(
    const std::string& rootPath,
    const RootIdentity& expected,
    const std::string& relPath,
    const std::vector<unsigned char>& content) {
  const Root root = openRoot(rootPath, &expected);
  const auto segments = splitAndValidate(relPath);
  if (segments.empty()) fail(GuardError::kInvalidArguments);
  const Fd parent = walkDirectories(root, parentSegmentsOf(segments), false);
  const std::string& finalName = segments.back();

  deferTermination();
  StagedFile staged;
  stageContent(staged, parent.value, content);

  abandonIfTerminationPending();
  // Linked from the open descriptor, never from the staging name, so what
  // appears at the destination is exactly the staged inode. A hard link never
  // replaces an existing name.
  const int error = linkFromFd(staged, finalName);
  if (error == EEXIST) fail(GuardError::kAlreadyExists);
  if (error == ENOENT) fail(GuardError::kNotFound);
  if (error != 0) {
    diagnose("linking the created file refused", error);
    fail(GuardError::kInternal);
  }
  // The destructor drops a named staging file's extra name.
  syncDirectory(parent.value);
}

void doReplace(
    const std::string& rootPath,
    const RootIdentity& expected,
    uint64_t targetDev,
    uint64_t targetIno,
    const std::string& relPath,
    const std::string& expectedSha256,
    const std::vector<unsigned char>& content) {
  const Root root = openRoot(rootPath, &expected);
  const auto segments = splitAndValidate(relPath);
  if (segments.empty()) fail(GuardError::kInvalidArguments);
  const Fd parent = walkDirectories(root, parentSegmentsOf(segments), false);
  const std::string& finalName = segments.back();

  const OpenedTarget target = openExistingRegularFile(parent.value, finalName, root.info);
  if (!sameVerifiedFile(target.fd.value, targetDev, targetIno, expectedSha256)) {
    fail(GuardError::kHashMismatch);
  }

  deferTermination();
  StagedFile staged;
  stageContent(staged, parent.value, content);
  // Keep the file's permission bits (an executable script stays executable).
  if (fchmod(staged.fd.value, target.info.mode & 0777) != 0) {
    diagnose("fchmod(staged) failed", errno);
    fail(GuardError::kInternal);
  }
  materialize(staged);
  abandonIfTerminationPending();

  if (!portableOnly()) {
    if (renameat2(parent.value, staged.name.c_str(), parent.value, finalName.c_str(), RENAME_EXCHANGE) == 0) {
      // The destination should now hold the staged file, and the staging
      // name whatever was there at the instant of the exchange. Prove both:
      // the staged inode is what is now visible, and what it displaced is the
      // inode verified above, still with the verified content.
      staged.committed = true;
      if (!nameRefersTo(parent.value, finalName, staged.info) ||
          !nameRefersTo(parent.value, staged.name, target.info) ||
          !stillVerified(target.fd.value, targetDev, targetIno, expectedSha256)) {
        if (renameat2(parent.value, staged.name.c_str(), parent.value, finalName.c_str(), RENAME_EXCHANGE) != 0) {
          diagnose("restoring a replaced file after a failed re-verification refused", errno);
          fail(GuardError::kInternal);
        }
        staged.committed = false;  // the staging name is ours again; the destructor removes it
        fail(GuardError::kHashMismatch);
      }
      if (unlinkat(parent.value, staged.name.c_str(), 0) != 0) {
        diagnose("removing the replaced file's staging name failed", errno);
      } else if (infoOf(target.fd.value).nlink != 0) {
        diagnose("the staging name no longer named the replaced file when it was removed", 0);
      }
      syncDirectory(parent.value);
      return;
    }
    const int error = errno;
    if (error == ENOENT) fail(GuardError::kNotFound);
    if (!unsupported(error)) {
      diagnose("renameat2(RENAME_EXCHANGE) refused", error);
      fail(GuardError::kInternal);
    }
  }

  // Portable path: the same verify-then-rename window the Windows helper has.
  if (!nameRefersTo(parent.value, finalName, target.info) ||
      !sameVerifiedFile(target.fd.value, targetDev, targetIno, expectedSha256)) {
    fail(GuardError::kHashMismatch);
  }
  if (renameat(parent.value, staged.name.c_str(), parent.value, finalName.c_str()) != 0) {
    if (errno == ENOENT) fail(GuardError::kNotFound);
    diagnose("renameat refused", errno);
    fail(GuardError::kInternal);
  }
  staged.committed = true;
  if (!nameRefersTo(parent.value, finalName, staged.info)) {
    // The staging name was replaced before the rename: something other than
    // the staged content now sits at the destination. Never report success.
    diagnose("the destination does not hold the staged content after the rename", 0);
    fail(GuardError::kInternal);
  }
  syncDirectory(parent.value);
}

/**
 * Move `from` to `to` in `parent` without ever replacing an existing `to`.
 * Returns errno, 0 on success. `expected` is the inode the caller means to
 * move; the portable path refuses to drop a name that no longer refers to it.
 */
int moveNoReplace(int parent, const std::string& from, const std::string& to, const FileInfo& expected) {
  if (!portableOnly()) {
    if (renameat2(parent, from.c_str(), parent, to.c_str(), RENAME_NOREPLACE) == 0) return 0;
    if (!unsupported(errno)) return errno;
  }
  // A hard link refuses an existing name just as RENAME_NOREPLACE does.
  if (linkat(parent, from.c_str(), parent, to.c_str(), 0) != 0) return errno;
  if (!nameRefersTo(parent, to, expected) || !nameRefersTo(parent, from, expected)) {
    // Something else was linked, or now sits at `from`: drop only the fresh
    // name this call created, whatever it links to.
    unlinkat(parent, to.c_str(), 0);
    return ESTALE;
  }
  if (unlinkat(parent, from.c_str(), 0) != 0) {
    const int error = errno;
    unlinkat(parent, to.c_str(), 0);
    return error;
  }
  return 0;
}

/** Put back whatever is at `from` under `to`, never replacing anything at `to`. Returns errno, 0 on success. */
int restoreName(int parent, const std::string& from, const std::string& to) {
  FileInfo current;
  int error = 0;
  if (!statAt(parent, from.c_str(), current, error)) return error;
  return moveNoReplace(parent, from, to, current);
}

void doDelete(
    const std::string& rootPath,
    const RootIdentity& expected,
    uint64_t targetDev,
    uint64_t targetIno,
    const std::string& relPath,
    const std::string& expectedSha256) {
  const Root root = openRoot(rootPath, &expected);
  const auto segments = splitAndValidate(relPath);
  if (segments.empty()) fail(GuardError::kInvalidArguments);
  const Fd parent = walkDirectories(root, parentSegmentsOf(segments), false);
  const std::string& finalName = segments.back();

  const OpenedTarget target = openExistingRegularFile(parent.value, finalName, root.info);
  if (!sameVerifiedFile(target.fd.value, targetDev, targetIno, expectedSha256)) {
    fail(GuardError::kHashMismatch);
  }

  deferTermination();
  abandonIfTerminationPending();
  // Take the name away from the target atomically, then prove what was taken.
  std::string quarantine;
  for (int attempt = 0;; ++attempt) {
    if (attempt == 8) fail(GuardError::kInternal);
    quarantine = randomTempName();
    const int error = moveNoReplace(parent.value, finalName, quarantine, target.info);
    if (error == 0) break;
    if (error == EEXIST) continue;
    if (error == ENOENT) fail(GuardError::kNotFound);
    if (error == ESTALE) fail(GuardError::kHashMismatch);
    diagnose("moving the target aside refused", error);
    fail(GuardError::kInternal);
  }

  if (!nameRefersTo(parent.value, quarantine, target.info) ||
      !stillVerified(target.fd.value, targetDev, targetIno, expectedSha256)) {
    const int error = restoreName(parent.value, quarantine, finalName);
    if (error != 0) {
      diagnose("restoring a file after a failed re-verification refused", error);
      fail(GuardError::kInternal);
    }
    fail(GuardError::kHashMismatch);
  }
  if (unlinkat(parent.value, quarantine.c_str(), 0) != 0) {
    diagnose("unlinkat refused", errno);
    const int error = restoreName(parent.value, quarantine, finalName);
    if (error != 0) diagnose("restoring a file after a failed delete refused", error);
    fail(GuardError::kInternal);
  }
  // The unlink was by name: prove it removed the verified inode's last name.
  if (infoOf(target.fd.value).nlink != 0) {
    diagnose("the quarantine name no longer named the verified file when it was removed", 0);
    fail(GuardError::kInternal);
  }
  syncDirectory(parent.value);
}

std::string hex64(uint64_t value) {
  char buffer[17];
  std::snprintf(buffer, sizeof(buffer), "%016llx", static_cast<unsigned long long>(value));
  return buffer;
}

}  // namespace

int main(int argc, char* argv[]) {
  if (argc < 3) {
    std::fprintf(stderr, "agent-relay-fs-guard: missing arguments\n");
    std::printf("ERR:INVALID_ARGUMENTS\n");
    return 1;
  }

  const std::string operation = argv[1];
  const std::string root = argv[2];

  try {
    if (operation == "identity") {
      if (argc != 3) fail(GuardError::kInvalidArguments);
      const Root opened = openRoot(root, nullptr);
      std::printf(
          "OK:%s:%s%s:%llu:%llu\n",
          hex64(opened.info.dev).c_str(),
          hex64(opened.info.ino).c_str(),
          hex64(opened.info.birth).c_str(),
          static_cast<unsigned long long>(opened.info.dev),
          static_cast<unsigned long long>(opened.info.ino));
      return std::fflush(stdout) == 0 ? 0 : 2;
    }

    if (argc < 5) fail(GuardError::kInvalidArguments);
    const RootIdentity expected = expectedRootIdentity(argv[3], argv[4]);

    if (operation == "mkdirp") {
      if (argc != 6) fail(GuardError::kInvalidArguments);
      doMkdirp(root, expected, argv[5]);
    } else if (operation == "create") {
      if (argc != 6) fail(GuardError::kInvalidArguments);
      doCreate(root, expected, argv[5], readBoundedStdin());
    } else if (operation == "replace") {
      if (argc != 9) fail(GuardError::kInvalidArguments);
      const uint64_t targetDev = parseDecimal64(argv[5]);
      const uint64_t targetIno = parseDecimal64(argv[6]);
      const std::string sha256 = validateSha256(argv[8]);
      doReplace(root, expected, targetDev, targetIno, argv[7], sha256, readBoundedStdin());
    } else if (operation == "delete") {
      if (argc != 9) fail(GuardError::kInvalidArguments);
      const uint64_t targetDev = parseDecimal64(argv[5]);
      const uint64_t targetIno = parseDecimal64(argv[6]);
      const std::string sha256 = validateSha256(argv[8]);
      doDelete(root, expected, targetDev, targetIno, argv[7], sha256);
    } else {
      fail(GuardError::kInvalidArguments);
    }
  } catch (const GuardFailure& failure) {
    std::printf("ERR:%s\n", codeName(failure.error));
    std::fflush(stdout);
    return failure.error == GuardError::kInternal ? 2 : 1;
  } catch (...) {
    std::printf("ERR:INTERNAL\n");
    std::fflush(stdout);
    return 2;
  }

  std::printf("OK\n");
  return std::fflush(stdout) == 0 ? 0 : 2;
}
