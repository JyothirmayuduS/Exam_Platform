import re
import os

with open("src/pages/StudentExam.tsx", "r") as f:
    code = f.read()

# Add missing import for ExamFlowScreens
import_stmt = 'import {\n  DownloadGateScreen,\n  InstalledScreen,\n  SystemCheckScreen,\n  DeviceAccessScreen,\n  RulesScreen,\n  SubmittedScreen\n} from "../components/exam/ExamFlowScreens";\n'

if "ExamFlowScreens" not in code:
    # Insert after last import
    imports_end = code.rfind("import ")
    imports_end = code.find("\n", imports_end) + 1
    code = code[:imports_end] + import_stmt + code[imports_end:]

# Replace gate
gate_replacement = """  if (step === "gate") {
    const osRaw = detectOS();
    const os = osLabel(osRaw);
    const href = downloadUrl(osRaw) || "";
    const downloadFilename =
      osRaw === "windows" ? "Vignan Exam Browser Setup.exe" :
      osRaw === "macos"   ? "Vignan Exam Browser.dmg" :
      osRaw === "linux"   ? "Vignan Exam Browser.AppImage" :
                            "Vignan Exam Browser Setup.exe";
    
    return (
      <DownloadGateScreen
        examName={examName}
        installer={installer}
        os={os}
        href={href}
        downloadFilename={downloadFilename}
        onDoneInstall={() => setStep("installed")}
        onPreview={() => {
          const url = new URL(window.location.href);
          url.searchParams.set("lockdown", "1");
          window.location.href = url.toString();
        }}
      />
    );
  }"""
code = re.sub(r'if \(step === "gate"\) \{.*?\n  \}', gate_replacement, code, flags=re.DOTALL)

# Replace installed
installed_replacement = """  if (step === "installed") {
    return (
      <InstalledScreen
        examName={examName}
        deepLinkTried={deepLinkTried}
        deepLinkFailed={deepLinkFailed}
        onEnter={() => {
          setDeepLinkTried(true);
          window.location.href = `vignan-exam://open?exam=${EXAM_ID}&roll=${STUDENT_ROLL}`;
          setTimeout(() => setDeepLinkFailed(true), 3000);
        }}
        onTryAgain={() => {
          window.location.href = `vignan-exam://open?exam=${EXAM_ID}&roll=${STUDENT_ROLL}`;
        }}
        onBack={() => setStep("gate")}
        downloadHref={downloadUrl(detectOS()) || ""}
        downloadFilename={detectOS() === "windows" ? "Vignan Exam Browser Setup.exe" : detectOS() === "macos" ? "Vignan Exam Browser.dmg" : "Vignan Exam Browser.AppImage"}
      />
    );
  }"""
code = re.sub(r'if \(step === "installed"\) \{.*?\n  \}', installed_replacement, code, flags=re.DOTALL)

# Replace check
check_replacement = """  if (step === "check") {
    return (
      <SystemCheckScreen
        examName={examName}
        checks={checks}
        checkIndex={checkIndex}
        checksDone={checksDone}
        checksPassed={checksPassed}
        onContinue={() => setStep("access")}
        onRecheck={() => { setChecks([]); setCheckIndex(0); setStep("gate"); setTimeout(() => setStep("check"), 0); }}
      />
    );
  }"""
code = re.sub(r'if \(step === "check"\) \{.*?\n  \}', check_replacement, code, flags=re.DOTALL)

# Replace access
access_replacement = """  if (step === "access") {
    const devicesReady = cam === "granted" && mic === "granted" && screen === "granted";
    return (
      <DeviceAccessScreen
        cam={cam}
        mic={mic}
        screen={screen}
        requesting={requesting}
        devicesReady={devicesReady}
        previewRef={previewRef}
        onRequest={requestAccess}
        onContinue={() => setStep("rules")}
      />
    );
  }"""
code = re.sub(r'if \(step === "access"\) \{.*?\n  \}', access_replacement, code, flags=re.DOTALL)

# Replace rules
rules_replacement = """  if (step === "rules") {
    return (
      <RulesScreen
        examName={examName}
        durationMin={DURATION_MIN}
        questionsLength={questions.length}
        agreed={agreed}
        onAgree={setAgreed}
        onStart={beginExam}
      />
    );
  }"""
code = re.sub(r'if \(step === "rules"\) \{.*?\n  \}', rules_replacement, code, flags=re.DOTALL)

# Replace submitted
submitted_replacement = """  if (step === "submitted") {
    return (
      <SubmittedScreen
        answeredCount={answeredCount}
        totalQuestions={questions.length}
        studentName={STUDENT_NAME}
        studentRoll={STUDENT_ROLL}
        violationsCount={violations.length}
      />
    );
  }"""
code = re.sub(r'if \(step === "submitted"\) \{.*?\n  \}', submitted_replacement, code, flags=re.DOTALL)

# Delete the AccessRow and Stat components from bottom since they're no longer used
code = re.sub(r'function AccessRow.*?\}', '', code, flags=re.DOTALL)
code = re.sub(r'function Stat.*?\}', '', code, flags=re.DOTALL)

# Add useAutosave usage
# Find: const q = questions[current] ?? questions[0];
# Insert useAutosave above it
autosave_code = """
  // Autosave answers every 10 seconds
  const { status: autosaveStatus } = useAutosave({
    examId: EXAM_ID,
    studentId,
    answers,
    answeredCount,
    minutesUsed: Math.round((DURATION_MIN * 60 - secondsLeft) / 60),
    intervalMs: 10000,
    enabled: step === "exam",
  });
"""
code = code.replace("  const q = questions[current] ?? questions[0];", autosave_code + "\n  const q = questions[current] ?? questions[0];")

# Modify ExamHeader to receive autosaveStatus
code = code.replace("isFullscreen={isFullscreen}", "isFullscreen={isFullscreen}\n        autosaveStatus={autosaveStatus}")

with open("src/pages/StudentExam.tsx", "w") as f:
    f.write(code)
