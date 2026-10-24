"""Original STEVE-1 semantics with explicit artifact placement and one component load.

This process receives pixels and declared text only. It never constructs a game,
opens a fixture, inspects a world, or runs a verifier.
"""
from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import random
import subprocess
import sys
from types import SimpleNamespace

from .artifacts import contained_file, verify_file, verify_runtime
from .reference_runner import ReferenceBoundaryError, policy_observation, validate_action


class StevePolicy:
    def __init__(self, spec):
        expected = {"artifacts", "runtime", "goal", "goals", "tokenizer_directory", "dependency_inventory_path", "gpu_uuid"}
        if not isinstance(spec, dict) or set(spec) != expected:
            raise ReferenceBoundaryError("Policy bootstrap has unknown/missing fields")
        root = Path("/reference")
        self.paths = {item["id"]: verify_file(root, item) for item in spec["artifacts"]}
        if set(self.paths) != {"architecture", "policy", "prior", "mineclip"}:
            raise ReferenceBoundaryError("Policy receives exactly its four inference artifacts")
        tokenizer = root / spec["tokenizer_directory"]
        if tokenizer.resolve(strict=True) != tokenizer or not tokenizer.is_dir():
            raise ReferenceBoundaryError("Unverified tokenizer cache path")
        ref = tokenizer / "hub/models--openai--clip-vit-base-patch16/refs/main"
        if ref.read_text().strip() != spec["goal"]["tokenizer_revision"]:
            raise ReferenceBoundaryError("Offline tokenizer revision mismatch")
        os.environ.update(HF_HOME=str(tokenizer), HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false")
        self.inventory = verify_runtime(spec["runtime"], contained_file(root, spec["dependency_inventory_path"]))
        for name in ("steve1", "mineclip", "minerl"):
            source = root / "sources" / name
            if source.resolve(strict=True) != source or not source.is_dir():
                raise ReferenceBoundaryError("Missing verified original source tree")
            sys.path.insert(0, str(source))
        import numpy as np
        import torch
        import gym
        from gym import spaces
        from steve1.MineRLConditionalAgent import MineRLConditionalAgent
        from steve1.VPT.agent import ENV_KWARGS, TARGET_ACTION_SPACE
        from steve1.config import MINECLIP_CONFIG, PRIOR_INFO
        from steve1.data.text_alignment.vae import load_vae_model
        from steve1.mineclip_code.load_mineclip import load as load_mineclip
        from steve1.utils.embed_utils import get_prior_embed
        from steve1.utils.mineclip_agent_env_utils import load_model_parameters

        if (torch.__version__.split("+")[0] != spec["runtime"]["torch"] or torch.version.cuda != spec["runtime"]["cuda"]
                or gym.__version__ != spec["runtime"]["gym"]):
            raise ReferenceBoundaryError("Torch/CUDA runtime mismatch")
        if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
            raise ReferenceBoundaryError("Exactly the selected CUDA device is required")
        visible = subprocess.run(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], check=True,
                                 capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
        if visible != [spec["gpu_uuid"]]:
            raise ReferenceBoundaryError("Actual isolated GPU identity differs from the declared device")
        self.np, self.torch = np, torch
        self.goal_spec = spec["goal"]
        random.seed(self.goal_spec["seed"])
        np.random.seed(self.goal_spec["seed"])
        torch.manual_seed(self.goal_spec["seed"])
        torch.cuda.manual_seed_all(self.goal_spec["seed"])
        torch.set_grad_enabled(False)
        policy_kwargs, head_kwargs = load_model_parameters(str(self.paths["architecture"]))
        # The upstream constructor only reads .task settings and .action_space.
        # Supply those real source-defined spaces without allocating a second game.
        source_spaces = SimpleNamespace(task=SimpleNamespace(**ENV_KWARGS), action_space=spaces.Dict(TARGET_ACTION_SPACE))
        self.agent = MineRLConditionalAgent(source_spaces, device="cuda", policy_kwargs=policy_kwargs, pi_head_kwargs=head_kwargs)
        state = torch.load(str(self.paths["policy"]), map_location="cuda", weights_only=True)
        if not isinstance(state, dict) or not all(isinstance(key, str) for key in state):
            raise ReferenceBoundaryError("Malformed policy checkpoint")
        state = {key.replace("module.policy.", ""): value for key, value in state.items()}
        # No strict=False fallback: a changed checkpoint/configuration is not a load success.
        self.agent.policy.load_state_dict(state, strict=True)
        self.agent.reset(cond_scale=self.goal_spec["cond_scale"])
        mineclip_config = {**MINECLIP_CONFIG, "ckpt": {**MINECLIP_CONFIG["ckpt"], "path": str(self.paths["mineclip"])}}
        self.mineclip = load_mineclip(mineclip_config, device="cuda")
        self.prior = load_vae_model({**PRIOR_INFO, "model_path": str(self.paths["prior"])})
        self.goals = {}
        goal_evidence = []
        for goal in spec["goals"]:
            if set(goal) != {"id", "text"} or goal["id"] in self.goals:
                raise ReferenceBoundaryError("Duplicate or private goal fields")
            embedding = get_prior_embed(goal["text"], self.mineclip, self.prior, "cuda")
            if embedding.shape != (1, 512) or str(embedding.dtype) != self.goal_spec["embedding_dtype"] or not np.isfinite(embedding).all():
                raise ReferenceBoundaryError("Goal embedding shape/dtype mismatch")
            embedding.setflags(write=False)
            self.goals[goal["id"]] = embedding
            goal_evidence.append({"id": goal["id"], "sha256": hashlib.sha256(embedding.tobytes()).hexdigest(),
                                  "dtype": str(embedding.dtype), "shape": list(embedding.shape),
                                  "bytes_base64": base64.b64encode(embedding.tobytes()).decode("ascii")})
        if set(self.goals) != {"dirt", "wood"}:
            raise ReferenceBoundaryError("Exactly two declared goals are required")
        torch.cuda.synchronize()
        self.active_goal = None
        self.evidence = {"runtime": spec["runtime"], "policy_config": policy_kwargs, "head_config": head_kwargs,
                         "checkpoint_key_compatibility": "strict", "goal_embeddings": goal_evidence,
                         "text_encoder_calls": 2, "prior_calls": 2, "policy_calls": 0,
                         "state_layout": self._state_layout(self.agent.hidden_state),
                         "cuda_capability": list(torch.cuda.get_device_capability()),
                         "gpu_name": torch.cuda.get_device_name(), "gpu_uuid": visible[0], "components_loaded_once": True,
                         "torch_peak_allocated_bytes": torch.cuda.max_memory_allocated(),
                         "torch_peak_reserved_bytes": torch.cuda.max_memory_reserved()}

    def _state_layout(self, value):
        if isinstance(value, self.torch.Tensor):
            return {"shape": list(value.shape), "dtype": str(value.dtype), "device": str(value.device)}
        if isinstance(value, (tuple, list)):
            return [self._state_layout(child) for child in value]
        if value is None:
            return None
        raise ReferenceBoundaryError("Unsupported recurrent state layout")

    def handle(self, kind, message):
        if kind == "reset" and set(message) == {"goal_id"} and message["goal_id"] in self.goals:
            self.agent.reset(cond_scale=self.goal_spec["cond_scale"])
            self.active_goal = message["goal_id"]
            return {"kind": "reset", "goal_id": self.active_goal}
        if kind != "action" or set(message) != {"pov", "goal_id"} or message["goal_id"] != self.active_goal:
            raise ReferenceBoundaryError("Policy command/goal ownership mismatch")
        frame = message["pov"]
        if not isinstance(frame, dict) or set(frame) != {"width", "height", "color", "dtype", "data_base64"}:
            raise ReferenceBoundaryError("Malformed process RGB message")
        decoded = dict(frame)
        decoded["data"] = base64.b64decode(decoded.pop("data_base64"), validate=True)
        observation = policy_observation({"pov": decoded})
        image = self.np.frombuffer(observation["pov"]["data"], dtype=self.np.uint8).reshape(360, 640, 3)
        with self.torch.no_grad(), self.torch.autocast(device_type="cuda", dtype=self.torch.float16):
            result = self.agent.get_action({"pov": image}, self.goals[self.active_goal])
        self.torch.cuda.synchronize()
        action = {}
        for name, value in result.items():
            array = self.np.asarray(value)
            shape = (1, 2) if name == "camera" else (1,)
            if array.shape != shape:
                raise ReferenceBoundaryError("Unexpected source action batch shape")
            action[name] = array[0].tolist()
        return {"kind": "action", "action": validate_action(action),
                "torch_allocated_bytes": self.torch.cuda.memory_allocated(), "torch_reserved_bytes": self.torch.cuda.memory_reserved(),
                "torch_peak_allocated_bytes": self.torch.cuda.max_memory_allocated(), "torch_peak_reserved_bytes": self.torch.cuda.max_memory_reserved()}

    def close(self):
        self.active_goal = None
        self.goals.clear()
        del self.agent, self.mineclip, self.prior
        self.torch.cuda.synchronize()
