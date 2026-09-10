#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr DWORD kJobDrainTimeoutMs = 10000;
constexpr DWORD kJobDrainPollMs = 10;
constexpr DWORD kStoppedExitCode = 130;

void diagnostic(const wchar_t* code) {
  std::wcerr << L"Agent Relay Windows job launcher failed: " << code << L".\n";
}

std::wstring quoteArgument(const std::wstring& value) {
  if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    return value;
  }

  std::wstring quoted = L"\"";
  std::size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'\"');
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

std::wstring commandLine(int argc, wchar_t* argv[]) {
  std::wstring result;
  for (int index = 1; index < argc; ++index) {
    if (!result.empty()) result.push_back(L' ');
    result.append(quoteArgument(argv[index]));
  }
  return result;
}

bool setKillOnClose(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  return SetInformationJobObject(
             job,
             JobObjectExtendedLimitInformation,
             &limits,
             sizeof(limits)) != FALSE;
}

bool waitForEmptyJob(HANDLE job) {
  const ULONGLONG deadline = GetTickCount64() + kJobDrainTimeoutMs;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &accounting,
            sizeof(accounting),
            nullptr) == FALSE) {
      return false;
    }
    if (accounting.ActiveProcesses == 0) return true;
    if (GetTickCount64() >= deadline) return false;
    Sleep(kJobDrainPollMs);
  }
}

enum class ControlPipeState { Open, Closed, Failed };

ControlPipeState controlPipeState(HANDLE input) {
  DWORD available = 0;
  if (PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) != FALSE) {
    return available == 0 ? ControlPipeState::Open : ControlPipeState::Closed;
  }
  return GetLastError() == ERROR_BROKEN_PIPE
             ? ControlPipeState::Closed
             : ControlPipeState::Failed;
}

int boundedExitCode(DWORD value) {
  return static_cast<int>(std::min<DWORD>(value, 255));
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc < 2 || argv[1] == nullptr || argv[1][0] == L'\0') {
    diagnostic(L"INVALID_ARGUMENTS");
    return 120;
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    diagnostic(L"CREATE_JOB_FAILED");
    return 121;
  }
  if (!setKillOnClose(job)) {
    diagnostic(L"CONFIGURE_JOB_FAILED");
    CloseHandle(job);
    return 122;
  }

  HANDLE controlInput = GetStdHandle(STD_INPUT_HANDLE);
  if (controlInput == nullptr || controlInput == INVALID_HANDLE_VALUE) {
    diagnostic(L"INVALID_CONTROL_PIPE");
    CloseHandle(job);
    return 128;
  }
  // This read end belongs only to the launcher. The target receives NUL, and
  // must not retain an unrelated duplicate of the supervisor's control handle.
  if (SetHandleInformation(controlInput, HANDLE_FLAG_INHERIT, 0) == FALSE) {
    diagnostic(L"CONFIGURE_CONTROL_PIPE_FAILED");
    CloseHandle(job);
    return 128;
  }

  SECURITY_ATTRIBUTES inheritable{};
  inheritable.nLength = sizeof(inheritable);
  inheritable.bInheritHandle = TRUE;
  HANDLE nullInput = CreateFileW(
      L"NUL",
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inheritable,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (nullInput == INVALID_HANDLE_VALUE) {
    diagnostic(L"CREATE_STDIN_FAILED");
    CloseHandle(job);
    return 129;
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = nullInput;
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

  PROCESS_INFORMATION process{};
  std::wstring mutableCommand = commandLine(argc, argv);
  if (CreateProcessW(
          argv[1],
          mutableCommand.data(),
          nullptr,
          nullptr,
          TRUE,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
          nullptr,
          nullptr,
          &startup,
          &process) == FALSE) {
    diagnostic(L"CREATE_PROCESS_FAILED");
    CloseHandle(nullInput);
    CloseHandle(job);
    return 123;
  }
  CloseHandle(nullInput);

  if (AssignProcessToJobObject(job, process.hProcess) == FALSE) {
    diagnostic(L"ASSIGN_JOB_FAILED");
    TerminateProcess(process.hProcess, 124);
    ResumeThread(process.hThread);
    WaitForSingleObject(process.hProcess, kJobDrainTimeoutMs);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    return 124;
  }

  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    diagnostic(L"RESUME_PROCESS_FAILED");
    TerminateJobObject(job, 125);
    WaitForSingleObject(process.hProcess, kJobDrainTimeoutMs);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    return 125;
  }
  CloseHandle(process.hThread);

  DWORD exitCode = kStoppedExitCode;
  for (;;) {
    const DWORD processState = WaitForSingleObject(process.hProcess, kJobDrainPollMs);
    if (processState == WAIT_OBJECT_0) {
      if (GetExitCodeProcess(process.hProcess, &exitCode) == FALSE) {
        diagnostic(L"READ_EXIT_FAILED");
        exitCode = 126;
      }
      break;
    }
    if (processState == WAIT_FAILED) {
      diagnostic(L"WAIT_PROCESS_FAILED");
      exitCode = 126;
      break;
    }

    const ControlPipeState control = controlPipeState(controlInput);
    if (control == ControlPipeState::Closed) break;
    if (control == ControlPipeState::Failed) {
      diagnostic(L"READ_CONTROL_FAILED");
      exitCode = 128;
      break;
    }
  }
  CloseHandle(process.hProcess);

  // The primary runtime may have crashed after creating helpers. Terminating
  // the job reaches those helpers even though their immediate parent is gone.
  // Do not let the launcher exit until the kernel reports the whole job empty:
  // its own exit is the evidence the Node supervisor relies on later.
  if (TerminateJobObject(job, exitCode) == FALSE) {
    diagnostic(L"TERMINATE_JOB_FAILED");
    CloseHandle(job);
    return 127;
  }
  if (!waitForEmptyJob(job)) {
    diagnostic(L"JOB_DRAIN_FAILED");
    CloseHandle(job);
    return 127;
  }

  CloseHandle(job);
  return boundedExitCode(exitCode);
}
