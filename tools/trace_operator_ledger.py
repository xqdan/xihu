#!/usr/bin/env python3
"""Offline operator-ledger tracer (MODEL-CH-01 of teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md).

ADR-0025: an offline generator, not part of `npm test`. Its JSON output is committed and reconciled on
the Node side (teams/model/src/traced_ledger.js, tests/regression/test_traced_operator_ledger.js).

What it does: builds the Hugging Face model definition on the meta device (no weights, no memory),
runs one decode token at a cached context of CONTEXT - 1 tokens through every decoder layer, the final
norm and the LM head, and records
  - every parameter: name, shape, numel, role (matmul / vector / lookup) and checkpoint storage
    (fp8 unless the FP8 checkpoint's modules_to_not_convert keeps it in bf16);
  - every matmul-class aten op with non-zero FLOPs (torch.utils.flop_counter registry), attributed to
    the innermost module that issued it, with its tensor shapes; other ops as a per-op count;
  - module calls (and, for the experts module, the number of selected token-expert pairs);
  - KV / index-key cache traffic in elements (the deployment dtype is a manifest ASSUMPTION, not traced).
Layers whose records are identical are grouped into one layer kind.

The trace is of the reference modeling code (eager attention, batched_mm experts). Where the reference
differs from the deployment kernels (it decompresses the latent KV cache through kv_b_proj and attends
densely over the whole context with a top-k mask), the Node reconciliation reports the difference; the
tracer does not correct it.

Requirements (not installed by this repository): Python >= 3.10, torch 2.14.x, transformers 5.19.x.
  python -m venv .venv && .venv/bin/pip install torch==2.14.1 transformers==5.19.0
Run from the repository root:
  python tools/trace_operator_ledger.py --model GLM-5.2
  -> teams/model/inputs/glm_5_2_traced_operator_ledger.json
Offline: pass --config-file / --quant-config-file with the config.json files of the pinned revisions.
"""
import argparse
import hashlib
import importlib
import inspect
import json
import platform
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "traced-operator-ledger/1"
EVIDENCE = "UNVERIFIED_PLANNING_MANIFEST"
CONTEXT = 1048576  # the planning context (teams/model/src/workload_derivation.js CONTEXT); T = CONTEXT at decode

MODELS = {
    "GLM-5.2": {
        "config": {"repo": "zai-org/GLM-5.2", "revision": "cf457fa734ab149ffef225f80893eb38c6ff5cdc"},
        "quantConfig": {"repo": "zai-org/GLM-5.2-FP8", "revision": "f33c6dc501ee5a2c7e35155653b1b1abbc320951"},
        "modeling": "transformers.models.glm_moe_dsa.modeling_glm_moe_dsa",
        "configModule": "transformers.models.glm_moe_dsa.configuration_glm_moe_dsa",
        "classes": {"config": "GlmMoeDsaConfig", "layer": "GlmMoeDsaDecoderLayer",
                    "norm": "GlmMoeDsaRMSNorm", "rotary": "GlmMoeDsaRotaryEmbedding"},
        # modules_to_not_convert uses checkpoint names; the modeling code names the indexer's head-weight
        # projection self_attn.indexer.weights_proj. ASSUMPTION, recorded in the ledger.
        "renames": [["self_attn.indexers_proj", "self_attn.indexer.weights_proj"]],
        "out": "teams/model/inputs/glm_5_2_traced_operator_ledger.json",
    },
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch_config(source, local):
    url = f"https://huggingface.co/{source['repo']}/raw/{source['revision']}/config.json"
    data = Path(local).read_bytes() if local else urllib.request.urlopen(url, timeout=60).read()
    return json.loads(data), {**source, "url": url, "sha256": sha256(data), "fetched": "local file" if local else "url"}


def not_convert_set(quant, renames):
    names = set()
    for name in quant["quantization_config"].get("modules_to_not_convert", []):
        for old, new in renames:
            name = name.replace(old, new)
        names.add(name)
    return names


class Tracer:
    """Records aten ops under a module stack kept by forward hooks; FLOPs from torch's flop registry."""

    def __init__(self, torch, root, prefix):
        from torch.utils._python_dispatch import TorchDispatchMode
        from torch.utils._pytree import tree_leaves
        from torch.utils.flop_counter import flop_registry

        self.ops = defaultdict(lambda: {"count": 0, "flops": 0})
        self.other = defaultdict(int)
        self.modules = {}
        self.stack = []
        self.handles = []
        tracer = self

        for name, mod in root.named_modules():
            full = f"{prefix}{name}" if name else prefix.rstrip(".")
            self.handles.append(mod.register_forward_pre_hook(lambda m, args, n=full: tracer._enter(m, args, n)))
            self.handles.append(mod.register_forward_hook(lambda m, args, out, n=full: tracer._leave(out, n)))

        class Mode(TorchDispatchMode):
            def __torch_dispatch__(self, func, types, args=(), kwargs=None):
                kwargs = kwargs or {}
                out = func(*args, **kwargs)
                packet = func.overloadpacket
                flops = int(flop_registry[packet](*args, **kwargs, out_val=out)) if packet in flop_registry else 0
                module = tracer.stack[-1] if tracer.stack else ""
                if flops:
                    shapes = [list(t.shape) for t in tree_leaves((args, kwargs)) if isinstance(t, torch.Tensor)]
                    rec = tracer.ops[(module, str(packet), json.dumps(shapes))]
                    rec["count"] += 1
                    rec["flops"] += flops
                else:
                    tracer.other[str(packet)] += 1
                return out

        self.mode = Mode()
        self.torch = torch

    def _enter(self, mod, args, name):
        self.stack.append(name)
        rec = self.modules.setdefault(name, {"class": type(mod).__name__, "calls": 0})
        rec["calls"] += 1
        if type(mod).__name__.endswith("Experts") and len(args) > 1:
            rec["selected"] = rec.get("selected", 0) + int(args[1].numel())

    def _leave(self, out, name):
        self.stack.pop()
        if isinstance(out, self.torch.Tensor) and name.endswith("indexer"):
            self.modules[name]["outputShape"] = list(out.shape)

    def __enter__(self):
        self.mode.__enter__()
        return self

    def __exit__(self, *exc):
        self.mode.__exit__(*exc)
        for h in self.handles:
            h.remove()

    def record(self, strip):
        ops = [{"module": strip(m), "op": op, "shapes": json.loads(s), **v} for (m, op, s), v in self.ops.items()]
        ops.sort(key=lambda o: (o["module"], o["op"], json.dumps(o["shapes"])))
        modules = {strip(k): v for k, v in sorted(self.modules.items())}
        return {"ops": ops, "otherOps": dict(sorted(self.other.items())), "modules": modules}


class LedgerCache:
    """Duck-typed cache: the attention calls update(k_pass, k_rot, layer) and the indexer update_indexer(k, layer).
    Returns meta tensors spanning past + new tokens and records the traffic in elements."""

    def __init__(self, torch, past):
        self.torch, self.past, self.layer = torch, past, {}

    def _full(self, t, dim):
        shape = list(t.shape)
        shape[dim] += self.past
        return self.torch.empty(shape, dtype=t.dtype, device=t.device)

    def update(self, k_pass, k_rot, layer_idx):  # [B, 1, S, kvLatent], [B, 1, S, rope]
        s = k_pass.shape[2]
        self.layer[layer_idx]["kv"] = {"appendTokens": s, "readTokens": self.past + s,
                                       "width": int(k_pass.shape[-1] + k_rot.shape[-1]),
                                       "referenceDtype": str(k_pass.dtype).replace("torch.", "")}
        return self._full(k_pass, 2), self._full(k_rot, 2)

    def update_indexer(self, k, layer_idx):  # [B, S, indexHeadDim]
        s = k.shape[1]
        self.layer[layer_idx]["index"] = {"appendTokens": s, "readTokens": self.past + s, "width": int(k.shape[-1]),
                                          "referenceDtype": str(k.dtype).replace("torch.", "")}
        return self._full(k, 1)


def parameters(module, prefix, not_convert, torch):
    out = []
    for mod_name, mod in module.named_modules():
        for p_name, p in mod.named_parameters(recurse=False):
            rel = f"{mod_name}.{p_name}" if mod_name else p_name
            full_mod = f"{prefix}{mod_name}" if mod_name else prefix.rstrip(".")
            role = "lookup" if isinstance(mod, torch.nn.Embedding) else ("matmul" if p.dim() >= 2 else "vector")
            storage = "bf16" if role != "matmul" or full_mod in not_convert else "fp8"
            out.append({"name": rel, "shape": list(p.shape), "numel": int(p.numel()), "role": role, "storage": storage})
    return out


def trace(model_id, args):
    import torch
    import transformers

    spec = MODELS[model_id]
    cfg_json, cfg_src = fetch_config(spec["config"], args.config_file)
    quant_json, quant_src = fetch_config(spec["quantConfig"], args.quant_config_file)
    modeling = importlib.import_module(spec["modeling"])
    config_mod = importlib.import_module(spec["configModule"])
    C = spec["classes"]
    config = getattr(config_mod, C["config"]).from_dict(cfg_json)
    config._attn_implementation = "eager"
    config._experts_implementation = "batched_mm"
    not_convert = not_convert_set(quant_json, spec["renames"])
    matched = set()

    torch.set_default_dtype(torch.bfloat16)
    meta = torch.device("meta")
    H, L = config.hidden_size, config.num_hidden_layers
    # RoPE tables are tiny: compute them on the CPU at the decode position, then move them to meta.
    rotary = getattr(modeling, C["rotary"])(config)
    cpu_pos = torch.full((1, 1), CONTEXT - 1, dtype=torch.long)
    pos_emb = tuple(t.to(meta) for t in rotary(torch.zeros(1, 1, H), cpu_pos))
    position_ids = cpu_pos.to(meta)
    mask = torch.zeros(1, 1, 1, CONTEXT, dtype=torch.bfloat16, device=meta)
    hidden = torch.empty(1, 1, H, dtype=torch.bfloat16, device=meta)
    cache = LedgerCache(torch, CONTEXT - 1)

    kinds, topk = {}, None
    for i in range(L):
        with meta:
            layer = getattr(modeling, C["layer"])(config, i)
        layer.eval()
        prefix = f"model.layers.{i}."
        params = parameters(layer, prefix, not_convert, torch)
        matched |= {f"{prefix}{n.rsplit('.', 1)[0]}" for n in (p["name"] for p in params)}
        cache.layer[i] = {}
        with torch.no_grad(), Tracer(torch, layer, prefix) as t:
            hidden, topk = layer(hidden, attention_mask=mask, position_ids=position_ids, past_key_values=cache,
                                 use_cache=True, position_embeddings=pos_emb, prev_topk_indices=topk)
        rec = {"parameters": params, **t.record(lambda n: n[len(prefix):] if n.startswith(prefix) else ""),
               "cache": {"kv": cache.layer[i].get("kv"), "index": cache.layer[i].get("index")}}
        key = json.dumps(rec, sort_keys=True)
        kinds.setdefault(key, {"layers": [], **rec})["layers"].append(i)
        del layer

    with meta:
        norm = getattr(modeling, C["norm"])(H, eps=config.rms_norm_eps)
        lm_head = torch.nn.Linear(H, config.vocab_size, bias=False)
        embed = torch.nn.Embedding(config.vocab_size, H)
    glob = {"parameters": [], "ops": [], "otherOps": {}, "modules": {}}
    for prefix, mod in (("model.embed_tokens.", embed), ("model.norm.", norm), ("lm_head.", lm_head)):
        glob["parameters"] += [{**p, "name": f"{prefix}{p['name']}"} for p in parameters(mod, prefix, not_convert, torch)]
        matched.add(prefix.rstrip("."))
    # The embedding lookup of one token is not traced; the final norm and the LM head are, in order.
    for prefix, mod in (("model.norm.", norm), ("lm_head.", lm_head)):
        with torch.no_grad(), Tracer(torch, mod, prefix) as t:
            hidden = mod(hidden)
        r = t.record(lambda n: n)
        glob["ops"] += r["ops"]
        glob["modules"].update(r["modules"])
        for k, v in r["otherOps"].items():
            glob["otherOps"][k] = glob["otherOps"].get(k, 0) + v

    mtp = re.compile(r"^model\.layers\.(\d+)\.")
    unmatched = sorted(n for n in not_convert if n not in matched
                       and not (mtp.match(n) and int(mtp.match(n).group(1)) >= L)
                       and not any(n.startswith(m + ".") for m in matched))

    tool = Path(__file__).resolve()
    modeling_file = Path(inspect.getsourcefile(modeling))
    return {
        "format": FORMAT,
        "modelId": model_id,
        "evidenceClass": EVIDENCE,
        "provenance": {
            "tool": tool.relative_to(ROOT).as_posix(),
            "toolSha256": sha256(tool.read_bytes()),
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "modeling": spec["modeling"],
            "modelingSha256": sha256(modeling_file.read_bytes()),
            "config": cfg_src,
            "quantConfig": quant_src,
            "checkpointRenames": spec["renames"],
            "device": "meta",
            "attnImplementation": "eager",
            "expertsImplementation": "batched_mm",
            "flopSource": "torch.utils.flop_counter.flop_registry (matmul-class ops; elementwise ops count 0)",
        },
        "scenario": {"batch": 1, "decodeTokens": 1, "contextTokens": CONTEXT, "cachedTokens": CONTEXT - 1},
        "global": glob,
        "layerKinds": list(kinds.values()),
        "unmatchedNotConvert": unmatched,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--model", default="GLM-5.2", choices=sorted(MODELS))
    ap.add_argument("--out", help="output path relative to the repository root")
    ap.add_argument("--config-file", help="local config.json of the pinned config revision")
    ap.add_argument("--quant-config-file", help="local config.json of the pinned FP8 checkpoint revision")
    args = ap.parse_args()
    ledger = trace(args.model, args)
    out = ROOT / (args.out or MODELS[args.model]["out"])
    out.write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    n = sum(len(k["layers"]) for k in ledger["layerKinds"])
    print(f"{out.relative_to(ROOT).as_posix()}: {args.model}, {n} layers in {len(ledger['layerKinds'])} kinds, "
          f"{len(ledger['unmatchedNotConvert'])} unmatched modules_to_not_convert entries", file=sys.stderr)


if __name__ == "__main__":
    main()
