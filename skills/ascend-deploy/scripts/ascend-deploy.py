#!/usr/bin/env python3
"""Safe Ascend NPU container test runner (dry-run by default).

Validated on b01 with quay.io/ascend/vllm-ascend:v0.23.0:
  - pass only selected /dev/davinciN nodes (plus manager/devmm/hdc)
  - do NOT set ASCEND_RT_VISIBLE_DEVICES (inside the container the passed
    devices are remapped to logical 0..N-1; host IDs make device_count()=0)
  - --rm + own label; the container exits by itself, never docker stop
"""
import argparse, base64, datetime, json, os, shlex, subprocess, sys

DEFAULT_IMAGE = "quay.io/ascend/vllm-ascend:v0.23.0"
DEFAULT_NPU_SMI = "/usr/local/bin/npu-smi"
COMMON_DEVICES = [
    "--device=/dev/davinci_manager",
    "--device=/dev/devmm_svm",
    "--device=/dev/hisi_hdc",
]
COMMON_MOUNTS = [
    "-v", "/usr/local/Ascend/driver:/usr/local/Ascend/driver:ro",
    "-v", "/usr/local/dcmi:/usr/local/dcmi:ro",
    "-v", "/etc/ascend_install.info:/etc/ascend_install.info:ro",
]

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(2)

def ssh(host, script, timeout=60):
    return subprocess.run(
        ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
         "-o", "ConnectTimeout=8", host, script],
        capture_output=True, text=True, timeout=timeout)

def parse_rate(text, key):
    for line in text.splitlines():
        if line.strip().startswith(key):
            try:
                return float(line.rsplit(":", 1)[1].strip())
            except ValueError:
                return None
    return None

def card_usage(host, card, npu_smi=DEFAULT_NPU_SMI):
    cmd = f"{shlex.quote(npu_smi)} info -t usages -i {int(card)}"
    p = ssh(host, cmd, timeout=25)
    if p.returncode != 0:
        die(f"card {card}: npu-smi failed: {p.stderr.strip()[:200]}")
    out = p.stdout
    hbm = parse_rate(out, "HBM Usage Rate(%)")
    aicore = parse_rate(out, "Aicore Usage Rate(%)")
    if hbm is None or aicore is None:
        die(f"card {card}: cannot parse usages output")
    return hbm, aicore

def check_cards(host, cards, npu_smi=DEFAULT_NPU_SMI):
    rows = []
    for c in cards:
        hbm, aicore = card_usage(host, c, npu_smi)
        rows.append((c, hbm, aicore))
        if hbm >= 10.0 or aicore >= 5.0:
            die(f"card {c} is not idle (HBM {hbm}%, AICore {aicore}%); refusing to use it")
    return rows

def b64(s):
    return base64.b64encode(s.encode()).decode()

def smoke_script():
    return r'''
import torch, torch_npu, time
print("available", torch.npu.is_available(), "count", torch.npu.device_count())
for i in range(torch.npu.device_count()):
    print("dev", i, torch.npu.get_device_name(i))
torch.npu.set_device(0)
x = torch.randn(2048, 2048, device="npu")
t0 = time.time()
for _ in range(5):
    y = x @ x
torch.npu.synchronize()
print("matmul_ok", float(y[0, 0].cpu()), "sec", round(time.time() - t0, 2))
'''

def serve_script(model_path, served_name, port, tp, max_model_len, bench):
    s = f'''set -e
vllm serve /models/{model_path} --served-model-name {served_name} --port {port} --tensor-parallel-size {tp} --max-model-len {max_model_len} > /tmp/vllm.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true' EXIT
ready=0
for i in $(seq 1 180); do
  if curl -sf http://127.0.0.1:{port}/v1/models >/dev/null; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != 1 ]; then echo "SERVER_NOT_READY"; cat /tmp/vllm.log; exit 1; fi
echo "SERVER_READY"
curl -s http://127.0.0.1:{port}/v1/models | head -c 500
echo
echo "COMPLETION"
curl -s http://127.0.0.1:{port}/v1/completions -H 'Content-Type: application/json' \
  -d '{{"model":"{served_name}","prompt":"Hello, my name is","max_tokens":16,"temperature":0}}'
echo
if [ "{bench}" = "1" ]; then
  vllm bench serve --model {served_name} --tokenizer /models/{model_path} --backend openai --base-url http://127.0.0.1:{port} \
    --dataset-name random --num-prompts 64 --max-concurrency 8
fi
'''
    return s

def main():
    ap = argparse.ArgumentParser(description="Run a safe container test on selected Ascend NPU cards (dry-run by default).")
    ap.add_argument("--host", required=True, help="SSH alias from ~/.ssh/config, e.g. b01")
    ap.add_argument("--npu-smi", default=DEFAULT_NPU_SMI, help="remote npu-smi path (default: /usr/local/bin/npu-smi)")
    ap.add_argument("--image", default=DEFAULT_IMAGE)
    ap.add_argument("--cards", required=True, help="comma separated NPU card IDs, e.g. 6,7")
    ap.add_argument("--mode", choices=["smoke", "serve", "exec"], default="smoke")
    ap.add_argument("--cmd", default="", help="command for --mode exec (runs inside the container)")
    ap.add_argument("--workspace", default="/home/z00919396", help="host dir to mount read-only at /workspace (user configurable)")
    ap.add_argument("--model-root", default="/home/z00919396/models", help="host dir to mount read-only at /models")
    ap.add_argument("--model", default="", help="model path relative to --model-root (serve mode)")
    ap.add_argument("--served-name", default="", help="served model name (default: basename of --model)")
    ap.add_argument("--port", type=int, default=18433)
    ap.add_argument("--tp", type=int, default=1)
    ap.add_argument("--max-model-len", type=int, default=4096)
    ap.add_argument("--bench", action="store_true", help="serve mode: run vllm bench serve after readiness")
    ap.add_argument("--timeout", type=int, default=900, help="container timeout seconds")
    ap.add_argument("--run", action="store_true", help="actually run; default only prints the docker command")
    ap.add_argument("--json", action="store_true", help="print a JSON result")
    args = ap.parse_args()

    cards = []
    for x in args.cards.split(","):
        x = x.strip()
        if not x.isdigit():
            die(f"bad card id: {x!r}")
        cards.append(int(x))
    if not cards:
        die("no cards")

    ws_probe = ssh(args.host, f"test -d {shlex.quote(args.workspace)}", timeout=15)
    if ws_probe.returncode != 0:
        die(f"workspace dir not found on {args.host}: {args.workspace}")

    if args.mode == "serve":
        if not args.model:
            die("--mode serve requires --model (relative to --model-root)")
        model_dir = args.model_root.rstrip("/") + "/" + args.model
        probe = ssh(args.host, f"test -d {shlex.quote(model_dir)}", timeout=15)
        if probe.returncode != 0:
            die(f"model dir not found on {args.host}: {model_dir}")
        if not args.served_name:
            args.served_name = args.model.rstrip("/").split("/")[-1]
        port_probe = ssh(args.host, f"ss -ltn 2>/dev/null | grep -q ':{int(args.port)} ' && echo BUSY || true", timeout=15)
        if "BUSY" in port_probe.stdout:
            die(f"port {args.port} is already listening on {args.host}")

    rows = check_cards(args.host, cards, args.npu_smi)
    name = "dsh-apf-test-" + datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    inner = ""
    if args.mode == "smoke":
        inner = f'python3 -c "import base64;exec(base64.b64decode(\'{b64(smoke_script())}\').decode())"'
    elif args.mode == "exec":
        if not args.cmd:
            die("--mode exec requires --cmd")
        inner = args.cmd
    else:
        inner = f'echo {b64(serve_script(args.model, args.served_name, args.port, args.tp, args.max_model_len, "1" if args.bench else "0"))} | base64 -d | bash'

    cmd = ["docker", "run", "--rm", "--name", name, "--label", "dsh-ascend-deploy.test=1"]
    for c in cards:
        cmd.append(f"--device=/dev/davinci{c}")
    cmd += COMMON_DEVICES + COMMON_MOUNTS
    cmd += ["-v", f"{args.workspace}:/workspace:ro"]
    if args.mode == "serve":
        cmd += ["-v", f"{args.model_root}:/models:ro", "-p", f"127.0.0.1:{args.port}:{args.port}"]
    cmd += [args.image, "timeout", str(int(args.timeout)), "bash", "-lc", inner]

    remote = " ".join(shlex.quote(x) for x in cmd)
    result = {"host": args.host, "cards": rows, "container": name, "mode": args.mode, "command": remote}
    if not args.run:
        result["dry_run"] = True
        print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else remote)
        return

    print(f"[ascend-deploy] running on {args.host}, cards {cards}, container {name}", file=sys.stderr)
    p = ssh(args.host, remote, timeout=args.timeout + 90)
    result.update({"exit_code": p.returncode, "stdout": p.stdout[-20000:], "stderr": p.stderr[-8000:]})
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(p.stdout)
        if p.stderr:
            print(p.stderr, file=sys.stderr)
    sys.exit(0 if p.returncode == 0 else 1)

if __name__ == "__main__":
    main()
