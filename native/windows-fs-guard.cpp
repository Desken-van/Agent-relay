/**
 * A narrowly-scoped, fixed-protocol helper that performs exactly one bounded
 * filesystem mutation (create / replace / delete a regular file, or create
 * missing directory components) inside an Ornith task worktree, binding every
 * step to already-open handles instead of re-resolving an attacker-swappable
 * pathname at the moment of the mutation.
 *
 * Windows has no public "openat"-style API: `CreateFileW` always resolves a
 * complete path string from scratch, so no amount of re-checking a path with
 * `lstat`/`realpath` before calling it can close a race where an ancestor
 * directory is replaced with a junction/symlink between the check and the
 * call. The only way to bind a mutation to already-validated ancestors is to
 * open each path component *relative to the previously opened directory
 * handle* via the NT native `NtCreateFile` — a handle keeps referring to the
 * same underlying object no matter what happens to the name that used to
 * point at it, so a rename/replace of an ancestor cannot redirect an open
 * relative to a handle obtained before the swap.
 *
 * `NtCreateFile` and the `FILE_*` create-option/disposition constants it
 * takes are not declared in the public Windows SDK headers (they belong to
 * the NT I/O manager, not Win32); they are forward-declared here with their
 * standard, ABI-stable, publicly documented signature and values, and
 * resolved against `ntdll.lib` at link time. This is the same well-precedented
 * technique used throughout low-level Windows tooling — nothing here is
 * private or reverse-engineered. Everything else (`SetFileInformationByHandle`
 * for the actual rename/delete, `BCrypt*` for SHA-256) is a fully public,
 * documented Win32/CNG API.
 *
 * Protocol: a fixed, closed set of operation names on argv, never a shell,
 * never arbitrary command text.
 *
 *   agent-relay-fs-guard.exe identity <root>
 *   agent-relay-fs-guard.exe mkdirp   <root> <volumeId> <fileId128> <relDir>
 *   agent-relay-fs-guard.exe create   <root> <volumeId> <fileId128> <relPath>          (content on stdin)
 *   agent-relay-fs-guard.exe replace  <root> <volumeId> <fileId128> <targetVolume> <targetFileIndex> <relPath> <sha256> (content on stdin)
 *   agent-relay-fs-guard.exe delete   <root> <volumeId> <fileId128> <targetVolume> <targetFileIndex> <relPath> <sha256>
 *
 * `root` is the caller's already-canonicalized worktree root (absolute). Every
 * mutation also carries the FILE_ID_INFO identity captured before model-driven
 * work began. Opening a different ordinary directory at the same pathname is
 * therefore refused just like a junction swap. New file content is read from
 * the private one-shot stdin pipe and staged through the already-bound root
 * handle; JavaScript never creates or removes pathname-based staging files.
 * `relPath`/`relDir` are POSIX-style, `/`-separated, relative to `root`; every
 * segment is re-validated here from scratch — the caller's own validation is
 * never trusted alone.
 *
 * Exactly one line is printed to stdout: `OK` on success, or `ERR:<CODE>` on a
 * recognised, closed-vocabulary failure. Exit code 0 means `OK`; 1 means a
 * recognised `ERR`; 2 means an internal/unexpected failure. Diagnostics may go
 * to stderr and are never parsed.
 */

#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>

#include <cstdio>
#include <cwchar>
#include <array>
#include <limits>
#include <string>
#include <vector>

#pragma comment(lib, "ntdll.lib")
#pragma comment(lib, "bcrypt.lib")

namespace {

/* -------------------------------------------------------------------------- */
/* NT native declarations: not in the public SDK headers, ABI-stable          */
/* -------------------------------------------------------------------------- */

#ifndef NTSYSAPI
#define NTSYSAPI DECLSPEC_IMPORT
#endif

#ifndef STATUS_SUCCESS
#define STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#endif
constexpr NTSTATUS kStatusStoppedOnSymlink = (NTSTATUS)0x8000002DL;
constexpr NTSTATUS kStatusObjectNameNotFound = (NTSTATUS)0xC0000034L;
constexpr NTSTATUS kStatusObjectPathNotFound = (NTSTATUS)0xC000003AL;
constexpr NTSTATUS kStatusObjectNameCollision = (NTSTATUS)0xC0000035L;
constexpr NTSTATUS kStatusObjectNameInvalid = (NTSTATUS)0xC0000033L;
constexpr NTSTATUS kStatusNotADirectory = (NTSTATUS)0xC0000103L;
constexpr NTSTATUS kStatusFileIsADirectory = (NTSTATUS)0xC00000BAL;
constexpr NTSTATUS kStatusAccessDenied = (NTSTATUS)0xC0000022L;
constexpr NTSTATUS kStatusSharingViolation = (NTSTATUS)0xC0000043L;
constexpr NTSTATUS kStatusDeletePending = (NTSTATUS)0xC0000056L;

// CreateDisposition values for NtCreateFile.
constexpr ULONG kFileSupersede = 0x00000000;
constexpr ULONG kFileOpen = 0x00000001;
constexpr ULONG kFileCreate = 0x00000002;
constexpr ULONG kFileOpenIf = 0x00000003;

// CreateOptions flags for NtCreateFile.
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileSynchronousIoNonalert = 0x00000020;
constexpr ULONG kFileNonDirectoryFile = 0x00000040;
constexpr ULONG kFileOpenForBackupIntent = 0x00004000;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;

// NtCreateFile itself is already declared by <winternl.h> on this SDK; only
// the CreateOptions/CreateDisposition constants above (which winternl.h does
// NOT provide, since they belong to the NT I/O manager rather than Win32) are
// hand-declared here.
//
// The Win32 `SetFileInformationByHandle` wrapper for `FileRenameInfo`
// (`FILE_RENAME_INFO`) rejects a non-NULL `RootDirectory` with
// ERROR_INVALID_PARAMETER — confirmed empirically against this SDK/OS build.
// A handle-relative rename/delete-by-handle is only available through the raw
// NT API, `NtSetInformationFile`, which is *not* declared here either
// (winternl.h's `FILE_INFORMATION_CLASS` is a placeholder enum with a single
// value). Both the function and the two information classes/structures this
// file needs are hand-declared below, with their standard, ABI-stable,
// publicly documented values (unchanged since Windows NT4).

extern "C" NTSYSAPI NTSTATUS NTAPI NtSetInformationFile(
    HANDLE FileHandle,
    PIO_STATUS_BLOCK IoStatusBlock,
    PVOID FileInformation,
    ULONG Length,
    FILE_INFORMATION_CLASS FileInformationClass);

constexpr FILE_INFORMATION_CLASS kFileRenameInformation = static_cast<FILE_INFORMATION_CLASS>(10);
constexpr FILE_INFORMATION_CLASS kFileDispositionInformation = static_cast<FILE_INFORMATION_CLASS>(13);

struct NativeFileRenameInformation {
  BOOLEAN ReplaceIfExists;
  HANDLE RootDirectory;
  ULONG FileNameLength;
  WCHAR FileName[1];
};

struct NativeFileDispositionInformation {
  BOOLEAN DeleteFile;
};

bool ntSucceeded(NTSTATUS status) {
  // Success (00) and Informational (01) severities both have bit 31 clear.
  // STATUS_STOPPED_ON_SYMLINK is Warning severity (bit 31 set) but still
  // hands back a valid, usable handle to the reparse point itself, so it is
  // treated as "got a handle" here alongside NT_SUCCESS — the caller always
  // inspects the handle's own attributes afterward regardless.
  return status >= 0 || status == kStatusStoppedOnSymlink;
}

/* -------------------------------------------------------------------------- */
/* Result vocabulary                                                          */
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

const wchar_t* codeName(GuardError error) {
  switch (error) {
    case GuardError::kReparseAncestor: return L"REPARSE_ANCESTOR";
    case GuardError::kNotDirectory: return L"NOT_DIRECTORY";
    case GuardError::kNotFound: return L"NOT_FOUND";
    case GuardError::kAlreadyExists: return L"ALREADY_EXISTS";
    case GuardError::kHashMismatch: return L"HASH_MISMATCH";
    case GuardError::kHardLinked: return L"HARD_LINKED";
    case GuardError::kNotAFile: return L"NOT_A_FILE";
    case GuardError::kRootInvalid: return L"ROOT_INVALID";
    case GuardError::kInvalidArguments: return L"INVALID_ARGUMENTS";
    default: return L"INTERNAL";
  }
}

struct GuardHandle {
  HANDLE value = nullptr;
  GuardHandle() = default;
  explicit GuardHandle(HANDLE handle) : value(handle) {}
  GuardHandle(const GuardHandle&) = delete;
  GuardHandle& operator=(const GuardHandle&) = delete;
  GuardHandle(GuardHandle&& other) noexcept : value(other.value) { other.value = nullptr; }
  GuardHandle& operator=(GuardHandle&& other) noexcept {
    if (this != &other) {
      reset();
      value = other.value;
      other.value = nullptr;
    }
    return *this;
  }
  ~GuardHandle() { reset(); }
  void reset() {
    if (value != nullptr && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    value = nullptr;
  }
  bool valid() const { return value != nullptr && value != INVALID_HANDLE_VALUE; }
};

/** Thrown internally to unwind straight to one fixed error report. */
struct GuardFailure {
  GuardError error;
};

struct RootIdentity {
  ULONGLONG volumeSerial = 0;
  std::array<unsigned char, 16> fileId{};
  DWORD legacyVolumeSerial = 0;
  ULONGLONG legacyFileIndex = 0;
};

RootIdentity rootIdentityOf(HANDLE handle) {
  FILE_ID_INFO fileIdInfo{};
  BY_HANDLE_FILE_INFORMATION legacy{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &fileIdInfo, sizeof(fileIdInfo)) ||
      !GetFileInformationByHandle(handle, &legacy)) {
    throw GuardFailure{GuardError::kRootInvalid};
  }

  RootIdentity identity;
  identity.volumeSerial = fileIdInfo.VolumeSerialNumber;
  memcpy(identity.fileId.data(), fileIdInfo.FileId.Identifier, identity.fileId.size());
  identity.legacyVolumeSerial = legacy.dwVolumeSerialNumber;
  identity.legacyFileIndex =
      (static_cast<ULONGLONG>(legacy.nFileIndexHigh) << 32) |
      static_cast<ULONGLONG>(legacy.nFileIndexLow);
  return identity;
}

int hexNibble(wchar_t value) {
  if (value >= L'0' && value <= L'9') return value - L'0';
  if (value >= L'a' && value <= L'f') return value - L'a' + 10;
  if (value >= L'A' && value <= L'F') return value - L'A' + 10;
  return -1;
}

ULONGLONG parseHex64(const std::wstring& value) {
  if (value.size() != 16) throw GuardFailure{GuardError::kInvalidArguments};
  ULONGLONG result = 0;
  for (wchar_t character : value) {
    const int nibble = hexNibble(character);
    if (nibble < 0) throw GuardFailure{GuardError::kInvalidArguments};
    result = (result << 4) | static_cast<ULONGLONG>(nibble);
  }
  return result;
}

std::array<unsigned char, 16> parseHex128(const std::wstring& value) {
  if (value.size() != 32) throw GuardFailure{GuardError::kInvalidArguments};
  std::array<unsigned char, 16> result{};
  for (size_t index = 0; index < result.size(); ++index) {
    const int high = hexNibble(value[index * 2]);
    const int low = hexNibble(value[index * 2 + 1]);
    if (high < 0 || low < 0) throw GuardFailure{GuardError::kInvalidArguments};
    result[index] = static_cast<unsigned char>((high << 4) | low);
  }
  return result;
}

RootIdentity expectedRootIdentity(const std::wstring& volumeSerial, const std::wstring& fileId) {
  RootIdentity identity;
  identity.volumeSerial = parseHex64(volumeSerial);
  identity.fileId = parseHex128(fileId);
  return identity;
}

ULONGLONG parseDecimal64(const std::wstring& value) {
  if (value.empty()) throw GuardFailure{GuardError::kInvalidArguments};
  ULONGLONG result = 0;
  for (wchar_t character : value) {
    if (character < L'0' || character > L'9') {
      throw GuardFailure{GuardError::kInvalidArguments};
    }
    const ULONGLONG digit = static_cast<ULONGLONG>(character - L'0');
    if (result > (std::numeric_limits<ULONGLONG>::max() - digit) / 10) {
      throw GuardFailure{GuardError::kInvalidArguments};
    }
    result = result * 10 + digit;
  }
  return result;
}

bool sameLegacyFileIdentity(
    HANDLE handle,
    ULONGLONG expectedVolumeSerial,
    ULONGLONG expectedFileIndex) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info)) {
    throw GuardFailure{GuardError::kInternal};
  }
  const ULONGLONG actualFileIndex =
      (static_cast<ULONGLONG>(info.nFileIndexHigh) << 32) |
      static_cast<ULONGLONG>(info.nFileIndexLow);
  return static_cast<ULONGLONG>(info.dwVolumeSerialNumber) == expectedVolumeSerial &&
      actualFileIndex == expectedFileIndex;
}

bool sameRootIdentity(const RootIdentity& actual, const RootIdentity& expected) {
  return actual.volumeSerial == expected.volumeSerial && actual.fileId == expected.fileId;
}

std::wstring hex64(ULONGLONG value) {
  wchar_t buffer[17]{};
  std::swprintf(buffer, sizeof(buffer) / sizeof(buffer[0]), L"%016llx", value);
  return buffer;
}

std::wstring hex128(const std::array<unsigned char, 16>& value) {
  static const wchar_t* digits = L"0123456789abcdef";
  std::wstring result;
  result.reserve(32);
  for (unsigned char byte : value) {
    result.push_back(digits[(byte >> 4) & 0xf]);
    result.push_back(digits[byte & 0xf]);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Path-component validation (independent of, never trusting, the caller's)   */
/* -------------------------------------------------------------------------- */

std::vector<std::wstring> splitAndValidate(const std::wstring& relative) {
  std::vector<std::wstring> segments;
  if (relative.empty()) return segments;

  std::wstring current;
  auto flush = [&]() {
    if (current.empty() || current == L"." || current == L"..") throw GuardFailure{GuardError::kInvalidArguments};
    if (current.find(L'\\') != std::wstring::npos || current.find(L':') != std::wstring::npos) {
      throw GuardFailure{GuardError::kInvalidArguments};
    }
    for (wchar_t ch : current) {
      if (ch <= 0x1f) throw GuardFailure{GuardError::kInvalidArguments};
    }
    if (current == L".git") throw GuardFailure{GuardError::kInvalidArguments};
    segments.push_back(current);
    current.clear();
  };

  for (wchar_t ch : relative) {
    if (ch == L'/') {
      flush();
    } else {
      current.push_back(ch);
    }
  }
  flush();
  return segments;
}

/* -------------------------------------------------------------------------- */
/* Handle-relative directory/file walk                                        */
/* -------------------------------------------------------------------------- */

/**
 * Open `root` itself. Refuses if it is a reparse point, not a directory, or
 * does not match the identity captured for this Ornith run. Omitting
 * FILE_SHARE_DELETE also pins this exact root object for the lifetime of the
 * helper operation, so it cannot be renamed after the identity comparison.
 */
GuardHandle openRoot(const std::wstring& root, const RootIdentity* expected = nullptr) {
  HANDLE handle = CreateFileW(
      root.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE) throw GuardFailure{GuardError::kRootInvalid};
  GuardHandle guard(handle);

  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(guard.value, &info)) throw GuardFailure{GuardError::kRootInvalid};
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw GuardFailure{GuardError::kRootInvalid};
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) throw GuardFailure{GuardError::kRootInvalid};
  if (expected != nullptr && !sameRootIdentity(rootIdentityOf(guard.value), *expected)) {
    throw GuardFailure{GuardError::kRootInvalid};
  }
  return guard;
}

/**
 * Open (or, if `createIfMissing`, create) exactly one directory component
 * relative to `parent`, never re-resolving anything by absolute path. Refuses
 * a reparse point or a non-directory unconditionally.
 */
GuardHandle openOrCreateChildDirectory(HANDLE parent, const std::wstring& name, bool createIfMissing) {
  UNICODE_STRING objectName;
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;

  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &objectName, 0, parent, nullptr);

  IO_STATUS_BLOCK ioStatus{};
  HANDLE handle = nullptr;
  NTSTATUS status = NtCreateFile(
      &handle,
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      &attributes,
      &ioStatus,
      nullptr,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      kFileOpen,
      kFileDirectoryFile | kFileSynchronousIoNonalert | kFileOpenReparsePoint | kFileOpenForBackupIntent,
      nullptr,
      0);

  if (!ntSucceeded(status)) {
    if (status == kStatusNotADirectory || status == kStatusFileIsADirectory) {
      throw GuardFailure{GuardError::kNotDirectory};
    }
    if (!createIfMissing) {
      if (status == kStatusObjectNameNotFound || status == kStatusObjectPathNotFound) {
        throw GuardFailure{GuardError::kNotFound};
      }
      throw GuardFailure{GuardError::kInternal};
    }
    if (status != kStatusObjectNameNotFound && status != kStatusObjectPathNotFound) {
      throw GuardFailure{GuardError::kInternal};
    }
    status = NtCreateFile(
        &handle,
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        &attributes,
        &ioStatus,
        nullptr,
        FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        kFileCreate,
        kFileDirectoryFile | kFileSynchronousIoNonalert | kFileOpenReparsePoint | kFileOpenForBackupIntent,
        nullptr,
        0);
    if (!ntSucceeded(status)) throw GuardFailure{GuardError::kInternal};
  }

  GuardHandle guard(handle);
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(guard.value, &info)) throw GuardFailure{GuardError::kInternal};
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw GuardFailure{GuardError::kReparseAncestor};
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) throw GuardFailure{GuardError::kNotDirectory};
  return guard;
}

/** Walk every directory segment (all of `segments` when `wholePath` is a
 * directory target, or all but the last when it names a file), relative to
 * `root`, never creating anything. Returns the last directory's handle. */
GuardHandle walkExistingDirectories(HANDLE root, const std::vector<std::wstring>& segments) {
  GuardHandle current(nullptr);
  HANDLE parent = root;
  std::vector<GuardHandle> chain;
  for (const auto& segment : segments) {
    GuardHandle next = openOrCreateChildDirectory(parent, segment, false);
    parent = next.value;
    chain.push_back(std::move(next));
  }
  if (chain.empty()) {
    // Duplicate the root handle so the return type is uniform for callers.
    HANDLE duplicate = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), root, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      throw GuardFailure{GuardError::kInternal};
    }
    return GuardHandle(duplicate);
  }
  return std::move(chain.back());
}

/** Like {@link walkExistingDirectories}, but creates any missing component. */
GuardHandle walkCreatingDirectories(HANDLE root, const std::vector<std::wstring>& segments) {
  HANDLE parent = root;
  std::vector<GuardHandle> chain;
  for (const auto& segment : segments) {
    GuardHandle next = openOrCreateChildDirectory(parent, segment, true);
    parent = next.value;
    chain.push_back(std::move(next));
  }
  if (chain.empty()) {
    HANDLE duplicate = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), root, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      throw GuardFailure{GuardError::kInternal};
    }
    return GuardHandle(duplicate);
  }
  return std::move(chain.back());
}

/** Open the final file component relative to `parent`. Never follows a
 * reparse point; rejects a directory, and (when `denyHardLinked`) a
 * hard-linked file. */
GuardHandle openFinalFile(
    HANDLE parent,
    const std::wstring& name,
    ACCESS_MASK access,
    ULONG shareAccess,
    ULONG createDisposition,
    bool denyHardLinked) {
  UNICODE_STRING objectName;
  objectName.Buffer = const_cast<PWSTR>(name.c_str());
  objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  objectName.MaximumLength = objectName.Length;

  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &objectName, 0, parent, nullptr);

  IO_STATUS_BLOCK ioStatus{};
  HANDLE handle = nullptr;
  NTSTATUS status = NtCreateFile(
      &handle,
      access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      &attributes,
      &ioStatus,
      nullptr,
      FILE_ATTRIBUTE_NORMAL,
      shareAccess,
      createDisposition,
      kFileNonDirectoryFile | kFileSynchronousIoNonalert | kFileOpenReparsePoint,
      nullptr,
      0);

  if (!ntSucceeded(status)) {
    if (status == kStatusObjectNameNotFound || status == kStatusObjectPathNotFound) {
      throw GuardFailure{GuardError::kNotFound};
    }
    if (status == kStatusObjectNameCollision) throw GuardFailure{GuardError::kAlreadyExists};
    if (status == kStatusFileIsADirectory) throw GuardFailure{GuardError::kNotAFile};
    // Sharing violation, access denied, delete-pending, and anything else
    // unexpected all fail closed the same way: a mutation this helper cannot
    // prove safe never partially applies.
    throw GuardFailure{GuardError::kInternal};
  }

  GuardHandle guard(handle);
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(guard.value, &info)) throw GuardFailure{GuardError::kInternal};
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw GuardFailure{GuardError::kReparseAncestor};
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) throw GuardFailure{GuardError::kNotAFile};
  if (denyHardLinked && info.nNumberOfLinks > 1) throw GuardFailure{GuardError::kHardLinked};
  return guard;
}

constexpr size_t kMaxContentBytes = 8 * 1024 * 1024;

std::vector<unsigned char> readBoundedStdin() {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE) {
    throw GuardFailure{GuardError::kInternal};
  }

  std::vector<unsigned char> content;
  std::array<unsigned char, 64 * 1024> chunk{};
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(input, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) break;
      throw GuardFailure{GuardError::kInternal};
    }
    if (read == 0) break;
    if (content.size() + read > kMaxContentBytes) {
      throw GuardFailure{GuardError::kInvalidArguments};
    }
    content.insert(content.end(), chunk.begin(), chunk.begin() + read);
  }
  return content;
}

void writeAll(HANDLE file, const std::vector<unsigned char>& content) {
  size_t written = 0;
  while (written < content.size()) {
    const DWORD requested = static_cast<DWORD>(
        std::min<size_t>(content.size() - written, static_cast<size_t>(64 * 1024)));
    DWORD chunk = 0;
    if (!WriteFile(file, content.data() + written, requested, &chunk, nullptr) || chunk == 0) {
      throw GuardFailure{GuardError::kInternal};
    }
    written += chunk;
  }
  if (!FlushFileBuffers(file)) throw GuardFailure{GuardError::kInternal};
}

std::wstring randomTempName() {
  std::array<unsigned char, 12> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    throw GuardFailure{GuardError::kInternal};
  }
  return L".ornith-tmp-" + hex128({
      random[0], random[1], random[2], random[3], random[4], random[5],
      random[6], random[7], random[8], random[9], random[10], random[11],
      0, 0, 0, 0
    }).substr(0, 24);
}

void markHandleForDeletion(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition));
}

struct StagedFile {
  GuardHandle handle;
  bool committed = false;

  explicit StagedFile(GuardHandle&& value) : handle(std::move(value)) {}
  StagedFile(const StagedFile&) = delete;
  StagedFile& operator=(const StagedFile&) = delete;
  StagedFile(StagedFile&& other) noexcept
      : handle(std::move(other.handle)), committed(other.committed) {
    other.committed = true;
  }
  ~StagedFile() {
    if (!committed && handle.valid()) markHandleForDeletion(handle.value);
  }
};

StagedFile stageContent(HANDLE root, const std::vector<unsigned char>& content) {
  for (int attempt = 0; attempt < 8; ++attempt) {
    const std::wstring name = randomTempName();
    try {
      GuardHandle handle = openFinalFile(
          root, name, GENERIC_WRITE | DELETE, FILE_SHARE_READ, kFileCreate, false);
      writeAll(handle.value, content);
      return StagedFile(std::move(handle));
    } catch (const GuardFailure& failure) {
      if (failure.error != GuardError::kAlreadyExists) throw;
    }
  }
  throw GuardFailure{GuardError::kInternal};
}

/* -------------------------------------------------------------------------- */
/* SHA-256 via CNG (BCrypt) — fully public, documented Win32 API              */
/* -------------------------------------------------------------------------- */

std::wstring sha256HexOfHandle(HANDLE fileHandle) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(fileHandle, &size) || size.QuadPart < 0) throw GuardFailure{GuardError::kInternal};
  // Same ceiling ORNITH_LIMITS.maxFileBytes enforces before this helper is
  // ever invoked; re-asserted here so this process never allocates an
  // unbounded buffer no matter what called it.
  constexpr LONGLONG kMaxBytes = 8LL * 1024 * 1024;
  if (size.QuadPart > kMaxBytes) throw GuardFailure{GuardError::kInternal};

  std::vector<unsigned char> buffer(static_cast<size_t>(size.QuadPart));
  size_t totalRead = 0;
  while (totalRead < buffer.size()) {
    DWORD chunk = 0;
    OVERLAPPED overlapped{};
    LARGE_INTEGER offset{};
    offset.QuadPart = static_cast<LONGLONG>(totalRead);
    overlapped.Offset = offset.LowPart;
    overlapped.OffsetHigh = static_cast<DWORD>(offset.HighPart);
    if (!ReadFile(fileHandle, buffer.data() + totalRead, static_cast<DWORD>(buffer.size() - totalRead), &chunk, &overlapped)) {
      throw GuardFailure{GuardError::kInternal};
    }
    if (chunk == 0) break;
    totalRead += chunk;
  }
  if (totalRead != buffer.size()) throw GuardFailure{GuardError::kInternal};

  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
    throw GuardFailure{GuardError::kInternal};
  }
  struct AlgorithmGuard {
    BCRYPT_ALG_HANDLE handle;
    ~AlgorithmGuard() { BCryptCloseAlgorithmProvider(handle, 0); }
  } algorithmGuard{algorithm};

  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) != 0) throw GuardFailure{GuardError::kInternal};
  struct HashGuard {
    BCRYPT_HASH_HANDLE handle;
    ~HashGuard() { BCryptDestroyHash(handle); }
  } hashGuard{hash};

  if (!buffer.empty()) {
    if (BCryptHashData(hash, buffer.data(), static_cast<ULONG>(buffer.size()), 0) != 0) {
      throw GuardFailure{GuardError::kInternal};
    }
  }

  unsigned char digest[32];
  if (BCryptFinishHash(hash, digest, sizeof(digest), 0) != 0) throw GuardFailure{GuardError::kInternal};

  static const wchar_t* kHex = L"0123456789abcdef";
  std::wstring hex;
  hex.reserve(64);
  for (unsigned char byte : digest) {
    hex.push_back(kHex[(byte >> 4) & 0xf]);
    hex.push_back(kHex[byte & 0xf]);
  }
  return hex;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

void doMkdirp(
    const std::wstring& root,
    const RootIdentity& expectedRoot,
    const std::wstring& relDir) {
  GuardHandle rootHandle = openRoot(root, &expectedRoot);
  auto segments = splitAndValidate(relDir);
  if (segments.empty()) return;
  walkCreatingDirectories(rootHandle.value, segments);
}

/** Rename an already-open staged file onto the destination under a bound parent handle. */
void renameTempInto(
    HANDLE rootHandle,
    const std::vector<std::wstring>& segments,
    HANDLE stagedFile,
    bool replaceIfExists) {
  std::vector<std::wstring> parentSegments(segments.begin(), segments.end() - 1);
  GuardHandle parent = walkExistingDirectories(rootHandle, parentSegments);
  const std::wstring& finalName = segments.back();

  const size_t infoSize = sizeof(NativeFileRenameInformation) + finalName.size() * sizeof(wchar_t);
  std::vector<unsigned char> buffer(infoSize);
  auto* info = reinterpret_cast<NativeFileRenameInformation*>(buffer.data());
  info->ReplaceIfExists = replaceIfExists ? TRUE : FALSE;
  info->RootDirectory = parent.value;
  info->FileNameLength = static_cast<ULONG>(finalName.size() * sizeof(wchar_t));
  memcpy(info->FileName, finalName.c_str(), info->FileNameLength);

  IO_STATUS_BLOCK ioStatus{};
  NTSTATUS status = NtSetInformationFile(
      stagedFile, &ioStatus, info, static_cast<ULONG>(buffer.size()), kFileRenameInformation);
  if (!ntSucceeded(status)) {
    std::fwprintf(stderr, L"agent-relay-fs-guard: rename refused (ntstatus=%08lx)\n", static_cast<unsigned long>(status));
    if (status == kStatusObjectNameCollision) throw GuardFailure{GuardError::kAlreadyExists};
    if (status == kStatusObjectNameNotFound || status == kStatusObjectPathNotFound) {
      throw GuardFailure{GuardError::kNotFound};
    }
    throw GuardFailure{GuardError::kInternal};
  }
}

void doCreate(
    const std::wstring& root,
    const RootIdentity& expectedRoot,
    const std::wstring& relPath,
    const std::vector<unsigned char>& content) {
  GuardHandle rootHandle = openRoot(root, &expectedRoot);
  auto segments = splitAndValidate(relPath);
  if (segments.empty()) throw GuardFailure{GuardError::kInvalidArguments};
  StagedFile staged = stageContent(rootHandle.value, content);
  renameTempInto(rootHandle.value, segments, staged.handle.value, false);
  staged.committed = true;
}

void doReplace(
    const std::wstring& root,
    const RootIdentity& expectedRoot,
    ULONGLONG expectedTargetVolume,
    ULONGLONG expectedTargetFileIndex,
    const std::wstring& relPath,
    const std::wstring& expectedSha256,
    const std::vector<unsigned char>& content) {
  GuardHandle rootHandle = openRoot(root, &expectedRoot);
  auto segments = splitAndValidate(relPath);
  if (segments.empty()) throw GuardFailure{GuardError::kInvalidArguments};

  std::vector<std::wstring> parentSegments(segments.begin(), segments.end() - 1);
  GuardHandle parent = walkExistingDirectories(rootHandle.value, parentSegments);
  StagedFile staged = stageContent(rootHandle.value, content);

  {
    // Deny concurrent writes to the destination for as long as this handle is
    // held; delete-sharing must stay open so the rename below (issued through
    // a different handle) can succeed. Verified and closed immediately before
    // the rename — the smallest gap this platform's primitives allow, and far
    // smaller than the previous multi-`await` pathname-based window.
    GuardHandle target = openFinalFile(
        parent.value, segments.back(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, kFileOpen, true);
    if (!sameLegacyFileIdentity(target.value, expectedTargetVolume, expectedTargetFileIndex)) {
      throw GuardFailure{GuardError::kHashMismatch};
    }
    std::wstring actual = sha256HexOfHandle(target.value);
    if (_wcsicmp(actual.c_str(), expectedSha256.c_str()) != 0) throw GuardFailure{GuardError::kHashMismatch};
  }

  renameTempInto(rootHandle.value, segments, staged.handle.value, true);
  staged.committed = true;
}

void doDelete(
    const std::wstring& root,
    const RootIdentity& expectedRoot,
    ULONGLONG expectedTargetVolume,
    ULONGLONG expectedTargetFileIndex,
    const std::wstring& relPath,
    const std::wstring& expectedSha256) {
  GuardHandle rootHandle = openRoot(root, &expectedRoot);
  auto segments = splitAndValidate(relPath);
  if (segments.empty()) throw GuardFailure{GuardError::kInvalidArguments};

  std::vector<std::wstring> parentSegments(segments.begin(), segments.end() - 1);
  GuardHandle parent = walkExistingDirectories(rootHandle.value, parentSegments);
  GuardHandle target = openFinalFile(
      parent.value, segments.back(), GENERIC_READ | DELETE, FILE_SHARE_READ, kFileOpen, true);

  if (!sameLegacyFileIdentity(target.value, expectedTargetVolume, expectedTargetFileIndex)) {
    throw GuardFailure{GuardError::kHashMismatch};
  }
  std::wstring actual = sha256HexOfHandle(target.value);
  if (_wcsicmp(actual.c_str(), expectedSha256.c_str()) != 0) throw GuardFailure{GuardError::kHashMismatch};

  // Atomic relative to this exact handle: no re-resolution by name between
  // the hash check above and the delete below.
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(target.value, FileDispositionInfo, &disposition, sizeof(disposition))) {
    throw GuardFailure{GuardError::kInternal};
  }
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc < 3) {
    std::fwprintf(stderr, L"agent-relay-fs-guard: missing arguments\n");
    std::wprintf(L"ERR:INVALID_ARGUMENTS\n");
    return 1;
  }

  const std::wstring operation = argv[1];
  const std::wstring root = argv[2];

  try {
    if (operation == L"identity") {
      if (argc != 3) throw GuardFailure{GuardError::kInvalidArguments};
      GuardHandle rootHandle = openRoot(root);
      const RootIdentity identity = rootIdentityOf(rootHandle.value);
      std::wprintf(
          L"OK:%ls:%ls:%lu:%llu\n",
          hex64(identity.volumeSerial).c_str(),
          hex128(identity.fileId).c_str(),
          static_cast<unsigned long>(identity.legacyVolumeSerial),
          identity.legacyFileIndex);
      return 0;
    }

    if (argc < 5) throw GuardFailure{GuardError::kInvalidArguments};
    const RootIdentity expected = expectedRootIdentity(argv[3], argv[4]);

    if (operation == L"mkdirp") {
      if (argc != 6) throw GuardFailure{GuardError::kInvalidArguments};
      doMkdirp(root, expected, argv[5]);
    } else if (operation == L"create") {
      if (argc != 6) throw GuardFailure{GuardError::kInvalidArguments};
      doCreate(root, expected, argv[5], readBoundedStdin());
    } else if (operation == L"replace") {
      if (argc != 9) throw GuardFailure{GuardError::kInvalidArguments};
      doReplace(
          root,
          expected,
          parseDecimal64(argv[5]),
          parseDecimal64(argv[6]),
          argv[7],
          argv[8],
          readBoundedStdin());
    } else if (operation == L"delete") {
      if (argc != 9) throw GuardFailure{GuardError::kInvalidArguments};
      doDelete(
          root,
          expected,
          parseDecimal64(argv[5]),
          parseDecimal64(argv[6]),
          argv[7],
          argv[8]);
    } else {
      throw GuardFailure{GuardError::kInvalidArguments};
    }
  } catch (const GuardFailure& failure) {
    std::wprintf(L"ERR:%ls\n", codeName(failure.error));
    return failure.error == GuardError::kInternal ? 2 : 1;
  } catch (...) {
    std::wprintf(L"ERR:INTERNAL\n");
    return 2;
  }

  std::wprintf(L"OK\n");
  return 0;
}
