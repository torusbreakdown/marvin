# Marvin-TS Code Review Report

**Review Date:** 2024
**Project:** marvin-ts TypeScript CLI Assistant
**Scope:** Full src/ directory review focusing on bugs, security, architecture, and type safety

---

## Executive Summary

The marvin-ts codebase demonstrates strong security awareness with SSRF protection, path traversal prevention, and command sanitization. However, several critical and high-severity issues were identified that would cause functionality to break in production.

**Critical Issues Found:** 1
**High Severity Issues Found:** 2
**Medium Severity Issues Found:** 3
**Low Severity Issues Found:** 2

---

## Critical Severity Issues

### Issue 1: Toolset Switching Completely Broken

**File:** `src/session.ts:300-311`
**Severity:** Critical
**Category:** Unimplemented Feature / Logic Error

**Problem:**
The `select_toolset` feature is advertised to users but completely non-functional. The `SessionManager.submit()` method calls `runToolLoop()` without passing the required `onToolsetSwitch` callback, even though the router has logic to handle it. When users try to activate a toolset in surf mode, the tool returns a success message but the new tools are never actually made available to the LLM.

**Evidence:**
```typescript
// src/session.ts:300-311
const result = await runToolLoop({
  prompt,
  toolFuncs,
  systemMessage,
  provider: this.provider,
  history: this.state.messages,
  maxRounds: this.providerConfig.maxToolRounds,
  tools: tools.length > 0 ? tools : undefined,
  signal: this.state.abortController.signal,
  onToolCall: callbacks?.onToolCallStart,
  onDelta: callbacks?.onDelta,
  // MISSING: onToolsetSwitch callback
});
```

The router at `src/llm/router.ts:78-89` has working logic to intercept `select_toolset` calls and swap tools, but it's never invoked because the callback isn't wired up.

**Impact:**
- Users in surf mode cannot access any toolsets (web, research, coding, media, local, productivity, blender, downloads)
- The assistant lies to users by saying "Toolset activated" when nothing actually happens
- This is a core feature advertised in the system prompt (line 62-68 of `system-prompt.ts`)

**Suggested Fix:**
Add the `onToolsetSwitch` callback to the `runToolLoop` call:

```typescript
const result = await runToolLoop({
  // ... existing params ...
  onToolsetSwitch: (toolsetName: string) => {
    const ts = TOOLSETS.find(t => t.name === toolsetName);
    if (!ts) return null;
    return ts.getTools(this.registry);
  },
});
```

---

## High Severity Issues

### Issue 2: apply_patch Only Replaces First Occurrence

**File:** `src/tools/files.ts:188`
**Severity:** High
**Category:** Bug / Logic Error

**Problem:**
The `apply_patch` tool uses JavaScript's `String.replace()` which only replaces the **first** occurrence of a string by default. If a user wants to edit multiple identical lines (e.g., renaming a variable used multiple times), only the first occurrence gets replaced. This is a subtle but serious bug that would cause incorrect file modifications.

**Evidence:**
```typescript
// src/tools/files.ts:188
const newContent = content.replace(args.old_str, args.new_str);
```

This is not `replaceAll()`, so it only replaces the first match.

**Impact:**
- Silent partial edits when the same code appears multiple times
- Users think their edit succeeded but only 1 out of N occurrences changed
- Could corrupt files with incomplete replacements
- Particularly dangerous for refactoring operations

**Suggested Fix:**
Add a check to ensure the string appears only once, or provide clear documentation:

```typescript
const occurrences = (content.match(new RegExp(escapeRegex(args.old_str), 'g')) || []).length;
if (occurrences > 1) {
  return `Error: old_str appears ${occurrences} times in ${args.path}. This tool only replaces the first occurrence. Please make old_str more specific to match exactly once.`;
}
if (occurrences === 0) {
  return `Error: old_str not found in ${args.path}`;
}
const newContent = content.replace(args.old_str, args.new_str);
```

---

### Issue 3: CopilotProvider Unimplemented But Silently Registered

**File:** `src/llm/copilot.ts:21-26`
**Severity:** High
**Category:** Unimplemented Feature

**Problem:**
The `CopilotProvider` is a stub that throws "not yet implemented" on every call, but users can select `--provider copilot` and the CLI will crash when they send their first message. The provider is listed as a valid option in help text and environment variables, misleading users into thinking it works.

**Evidence:**
```typescript
// src/llm/copilot.ts:21-26
async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
  throw new Error(
    'CopilotProvider.chat() is not yet implemented. ' +
    'Install @github/copilot-sdk and implement the SDK lifecycle.',
  );
}
```

But in `main.ts:250`, copilot is listed as a valid provider with a default model.

**Impact:**
- Users waste time debugging why `--provider copilot` crashes
- No runtime validation prevents selection of non-functional provider
- @github/copilot-sdk is listed as optionalDependency but there's no graceful fallback

**Suggested Fix:**
Either:
1. Remove copilot from the provider list until implemented
2. Add validation in `resolveProviderConfig()` to check if provider is implemented and show helpful error
3. Implement the provider using the Copilot SDK

---

## Medium Severity Issues

### Issue 4: Unsafe Fetch Calls Without SSRF Protection

**File:** Multiple files in `src/tools/`
**Severity:** Medium
**Category:** Security Issue

**Problem:**
Several tool files make direct `fetch()` calls to user-controlled URLs without going through the SSRF protection layer (`isPrivateUrl`). While most are to trusted third-party APIs, some accept user input in URL construction.

**Evidence:**

**Missing SSRF checks:**
- `src/tools/travel.ts:15, 48, 80` - Direct fetch to OpenStreetMap and OSRM APIs
- `src/tools/weather.ts:34` - Direct fetch to open-meteo.com
- `src/tools/utilities.ts:152, 173, 208` - Direct fetch to exchangerate.host, dictionaryapi.dev, mymemory.translated.net
- `src/tools/recipes.ts:17, 40` - Direct fetch to themealdb.com
- `src/tools/places.ts:11, 45, 64, 149` - Direct fetch to Google Places and OpenStreetMap

**Good example (web.ts):**
```typescript
// src/tools/web.ts:10-29 shows proper SSRF protection with redirect following
const redirectErr = validateUrl(location);
if (redirectErr) throw new Error(`Redirect blocked (SSRF): ${redirectErr}`);
```

**Impact:**
- If any of these APIs get compromised or allow parameter injection, an attacker could potentially trigger SSRF
- The risk is lower because most are well-known public APIs, but defense-in-depth is missing
- Recipe search accepts meal_id from user which constructs URL

**Suggested Fix:**
Wrap all external fetches in a helper that validates URLs:
```typescript
async function safeFetch(url: string, options?: RequestInit): Promise<Response> {
  const err = isPrivateUrl(url);
  if (err) throw new Error(err);
  return fetch(url, options);
}
```

---

### Issue 5: Empty Catch Blocks Silently Swallow Errors

**File:** Multiple locations
**Severity:** Medium
**Category:** Bug / Missing Error Handling

**Problem:**
Several catch blocks are completely empty or only contain comments like `/* ignore */`, which makes debugging very difficult. If something unexpected goes wrong, the error is completely invisible.

**Evidence:**
```typescript
// src/tools/files.ts:58 - getTree function
try {
  // ... read directory
} catch { /* ignore */ }

// src/profiles/manager.ts:55, 67, 75, 85 - Multiple JSON parse operations
try {
  savedPlaces = JSON.parse(readFileSync(placesPath, 'utf-8'));
} catch { /* ignore */ }
```

**Impact:**
- Silent failures make debugging impossible
- Users don't know why features aren't working
- Corrupt JSON files or permission errors go unreported

**Suggested Fix:**
At minimum, log errors to stderr or a debug log:
```typescript
try {
  savedPlaces = JSON.parse(readFileSync(placesPath, 'utf-8'));
} catch (err) {
  // Default to empty array if file doesn't exist or is corrupt
  if (process.env.DEBUG) {
    console.error(`Failed to load saved places: ${err}`);
  }
  savedPlaces = [];
}
```

---

### Issue 6: Command Injection Risk in Downloads Tool

**File:** `src/tools/downloads.ts:24, 52`
**Severity:** Medium
**Category:** Security Issue (Command Injection)

**Problem:**
While `JSON.stringify()` is used for shell escaping, this is not a robust defense against command injection. If a URL contains characters that break JSON escaping or if the shell interprets escaped sequences in unexpected ways, an attacker could inject commands.

**Evidence:**
```typescript
// src/tools/downloads.ts:24
execSync(`curl -fSL -o ${JSON.stringify(filePath)} ${JSON.stringify(url)}`, {
  stdio: 'pipe',
});

// src/tools/downloads.ts:52
execSync(
  `yt-dlp --no-playlist -f ${JSON.stringify(format)} -o ${JSON.stringify(outputTemplate)} ${JSON.stringify(url)}`,
  { stdio: 'pipe', encoding: 'utf-8' },
);
```

**Impact:**
- If JSON.stringify() escaping is bypassed, arbitrary command execution
- Risk is mitigated by the fact that URLs must be valid (new URL() call on line 22 would throw on malformed input)
- However, shell commands should use array-based APIs, not string concatenation

**Suggested Fix:**
Use `execFile` instead of `execSync` with template strings:
```typescript
import { execFileSync } from 'child_process';

// Safe: no shell interpretation
execFileSync('curl', ['-fSL', '-o', filePath, url], { stdio: 'pipe' });
execFileSync('yt-dlp', ['--no-playlist', '-f', format, '-o', outputTemplate, url], {
  stdio: 'pipe',
  encoding: 'utf-8',
});
```

---

## Low Severity Issues

### Issue 7: Race Condition in Path Validation

**File:** `src/tools/files.ts:119-127`
**Severity:** Low
**Category:** Security Issue (TOCTOU)

**Problem:**
There's a time-of-check to time-of-use (TOCTOU) race condition in `create_file`. The code checks if the parent directory exists and validates it doesn't escape via symlink, but an attacker could swap the directory with a symlink between the check and the mkdir/write operations.

**Evidence:**
```typescript
// src/tools/files.ts:119-127
const dir = dirname(fullPath);
if (existsSync(dir)) {
  const symlinkErr = validateRealPath(dir, ctx);
  if (symlinkErr) return symlinkErr;
}
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
// RACE: directory could be swapped here
const parentCheck = validateRealPath(dir, ctx);
if (parentCheck) return parentCheck;
writeFileSync(fullPath, args.content, 'utf-8');
```

**Impact:**
- Extremely low risk in practice (requires attacker to have filesystem access and winning a race)
- If exploited, could write files outside the working directory
- The re-check on line 126 helps but doesn't eliminate the race

**Suggested Fix:**
Use `fs.openSync()` with `O_CREAT | O_EXCL` flags and validate the final path after writing, or use a safer API that prevents following symlinks during creation.

---

### Issue 8: Packages Tool Uses Unsafe execSync

**File:** `src/tools/packages.ts:42`
**Severity:** Low
**Category:** Security Issue (Command Injection)

**Problem:**
The `install_packages` tool builds shell commands using string concatenation with user-provided package names. While package names are typically safe, this pattern is dangerous if an attacker can control the package list.

**Evidence:**
```typescript
// src/tools/packages.ts:29-42
const pkgList = packages.join(' ');
let cmd: string;
if (manager === 'npm') {
  cmd = `npm install ${dev ? '--save-dev ' : ''}${pkgList}`;
} else if (manager === 'pip') {
  cmd = `pip install ${pkgList}`;
} else if (manager === 'apt') {
  cmd = `sudo apt-get install -y ${pkgList}`;
}
const output = execSync(cmd, { encoding: 'utf-8', cwd, timeout: 120_000 });
```

**Impact:**
- Package names like `; rm -rf /` could be injected if an LLM hallucinates malicious package names
- Risk is low because the LLM would have to generate both the malicious name and convince the user (if interactive) or escape sandbox (if non-interactive)
- Still violates defense-in-depth principles

**Suggested Fix:**
Use `execFileSync` with array arguments:
```typescript
if (manager === 'npm') {
  const args = ['install'];
  if (dev) args.push('--save-dev');
  args.push(...packages);
  execFileSync('npm', args, { encoding: 'utf-8', cwd, timeout: 120_000 });
}
```

---

## Architectural Observations (No Action Required)

### Positive Findings:

1. **Excellent SSRF Protection**: The `ssrf.ts` module has comprehensive checks for IPv4/IPv6 loopback, private ranges, link-local addresses, hex/octal/decimal IP representations, and even IPv6-mapped IPv4. This is production-grade security.

2. **Strong Path Traversal Prevention**: The file tools validate against `..` traversal, absolute paths, null bytes, and symlink escapes. The implementation follows security best practices.

3. **Good Command Sanitization**: The shell tool filters sensitive environment variables and strips ANSI escape codes from command previews to prevent terminal injection.

4. **Proper Type Safety**: The codebase uses strict TypeScript with comprehensive Zod schemas. The type system is well-designed with minimal `any` usage.

5. **Context Budget Management**: The context compaction logic is well thought out with thresholds and automatic summarization.

### Architectural Concerns (Non-Critical):

1. **Tool Registry Coupling**: The registry mixes schema conversion (Zod → JSON Schema) with tool execution. Consider separating concerns.

2. **Provider Abstraction**: The provider interface is clean, but error messages leak implementation details (e.g., "fetch failed" in connection errors).

3. **No Circular Dependency Check**: Build passed, so no circular imports detected, but the deep nesting of `src/tools/` with many cross-imports could become problematic.

---

## Testing Recommendations

1. **Critical Priority**: Add integration test for toolset switching in surf mode
2. **High Priority**: Add unit tests for `apply_patch` with duplicate strings
3. **High Priority**: Add tests to verify unimplemented providers throw early (before user sends message)
4. **Medium Priority**: Add fuzzing tests for SSRF protection edge cases
5. **Medium Priority**: Add tests for command injection vectors in downloads and packages tools

---

## Summary of Findings

| Severity | Count | Must Fix Before Release |
|----------|-------|-------------------------|
| Critical | 1     | ✅ Yes                  |
| High     | 2     | ✅ Yes                  |
| Medium   | 3     | ⚠️ Recommended          |
| Low      | 2     | ℹ️ Optional             |

**Total Issues:** 8

**Overall Assessment:**
The codebase demonstrates strong security awareness and good TypeScript practices. However, the toolset switching feature is completely broken (critical bug), and there are two high-severity issues that would cause incorrect behavior in production. The medium and low severity issues are defense-in-depth improvements rather than immediate threats.

**Recommendation:** Fix the 3 high/critical issues before any production deployment. The security posture is generally good, but the broken features would significantly impact user experience.

---

**Reviewer Notes:**
- Build succeeded with no TypeScript errors (good type safety)
- No credential leaks found in code
- SSRF protection is notably thorough and well-commented
- The codebase appears to be a work-in-progress with some features (Copilot provider) intentionally stubbed
- Code quality is high overall, with clear comments explaining security decisions
