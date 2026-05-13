# TUI Startup Benchmark

Use this recipe to compare OpenCode TUI startup time with and without the smart
session picker plugin. Pick a busy local workspace and export it before running:

```bash
export OPENCODE_BENCH_WORKSPACE=<busy-workspace>
```

## What To Measure

- `TTFD`: OpenCode's built-in `Time to first draw` value, enabled with
  `OPENCODE_SHOW_TTFD=1`.
- `prompt_ms`: wall-clock time from process start until the main prompt text
  (`Ask anything`) appears in the terminal frame.
- `first_output_ms`: wall-clock time until the process first writes terminal
  output. This is a coarse sanity check, not the primary startup metric.

## Plugin Vs No-Plugin Run

Run this from the repo root:

```bash
python3 - <<'PY'
import json, os, pty, re, select, signal, statistics, struct, subprocess, tempfile, termios, time, fcntl

workspace = os.environ["OPENCODE_BENCH_WORKSPACE"]
plugin_cfg = os.path.expanduser("~/.config/opencode/tui.json")

no_plugin = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
json.dump({"$schema": "https://opencode.ai/tui.json", "plugin": []}, no_plugin)
no_plugin.write("\n")
no_plugin.close()

ansi_re = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
osc_re = re.compile(r"\x1b\][^\a]*(?:\a|\x1b\\)")

def clean(text):
    text = osc_re.sub("", text)
    text = ansi_re.sub("", text)
    return "".join(ch if ch.isprintable() or ch in "\n\r\t" else " " for ch in text)

def run(label, cfg):
    env = os.environ.copy()
    env["OPENCODE_SHOW_TTFD"] = "1"
    env["OPENCODE_TUI_CONFIG"] = cfg
    env["TERM"] = "xterm-256color"

    start = time.monotonic()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    proc = subprocess.Popen(
        ["opencode", workspace],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        cwd=workspace,
        start_new_session=True,
    )
    os.close(slave)

    raw = b""
    first_output_ms = None
    prompt_ms = None
    ttfd_ms = None

    try:
        while time.monotonic() - start < 12:
            ready, _, _ = select.select([master], [], [], 0.05)
            if not ready:
                continue
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if data and first_output_ms is None:
                first_output_ms = (time.monotonic() - start) * 1000
            raw += data
            text = clean(raw.decode("utf-8", "replace"))
            if prompt_ms is None and "Ask anything" in text:
                prompt_ms = (time.monotonic() - start) * 1000
            match = re.search(r"Time to first draw:\s*([0-9.]+)ms", text)
            if match:
                ttfd_ms = float(match.group(1))
            if prompt_ms is not None and ttfd_ms is not None:
                break
    finally:
        try:
            os.killpg(proc.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        time.sleep(0.15)
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            os.close(master)
        except OSError:
            pass

    return {
        "label": label,
        "ttfd_ms": ttfd_ms,
        "prompt_ms": prompt_ms,
        "first_output_ms": first_output_ms,
    }

results = []

for label, cfg in [("plugin", plugin_cfg), ("no_plugin", no_plugin.name)]:
    print("warmup", run(label, cfg), flush=True)

for i in range(5):
    for label, cfg in [("plugin", plugin_cfg), ("no_plugin", no_plugin.name)]:
        row = run(label, cfg)
        row["run"] = i + 1
        results.append(row)
        print(row, flush=True)

print("\nSUMMARY")
for label in ["plugin", "no_plugin"]:
    rows = [row for row in results if row["label"] == label]
    for key in ["ttfd_ms", "prompt_ms", "first_output_ms"]:
        values = [row[key] for row in rows if row[key] is not None]
        print(
            label,
            key,
            "n",
            len(values),
            "mean",
            round(statistics.mean(values), 1),
            "median",
            round(statistics.median(values), 1),
            "min",
            round(min(values), 1),
            "max",
            round(max(values), 1),
        )
print("no_plugin_config", no_plugin.name)
PY
```

## Notes

- This measures installed `opencode`, not the disposable upstream dev launcher.
- Keep the workspace fixed to make runs comparable.
- Run plugin and no-plugin measurements alternately to reduce cache and system
  load bias.
- Treat differences below roughly `100ms` as noise unless they reproduce across
  multiple runs.
