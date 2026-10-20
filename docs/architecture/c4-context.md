# System context

GameHarness connects strategic models, fast decision providers, and game-specific adapters. This is the planned product context, not a claim that any integration is already implemented. See the [container view](c4-containers.md) for process boundaries and the [architecture overview](overview.md) for design choices.

```mermaid
---
title: GameHarness system context
---
flowchart TB
    operator["Operator<br/>Person<br/>Sets tasks and watches play"]
    harness["GameHarness<br/>Software system<br/>Runs model-authored skills and policies"]
    game["Supported game<br/>External system<br/>Adapter-controlled environment"]
    strategic["Strategic providers<br/>External systems<br/>API and subscription connections"]
    fast["Fast decision providers<br/>External systems<br/>Typed choices, initially Jev"]
    docs["Documentation and web<br/>External systems<br/>Untrusted reference material"]
    operator -->|"Sets goals and controls runs<br/>Operator UI"| harness
    harness -->|"Observes and acts<br/>Game adapter transport"| game
    harness -->|"Requests plans and programs<br/>Provider transport"| strategic
    harness -->|"Requests policy choices<br/>Provider transport"| fast
    harness -->|"Retrieves references<br/>Brokered HTTPS"| docs
```

The operator is a person. GameHarness is the system being built. The other boxes are external systems; their internals are outside this model.

A supported game needs an implemented adapter, a declared observation profile, mechanic schemas, a live view, task verification, and evidence of its cancellation/recovery behavior. Extensibility does not mean that an arbitrary game works without integration. Minecraft Java is the first planned complete adapter.

One strategic agent controls one avatar in the initial runtime. A Jev-backed policy is a tool of that agent, while a local-code policy can make decisions without network inference. The core does not prescribe game-specific reactions for either backend.

The live view and activity feed expose current behavior and actual outcomes. Model explanations do not replace game evidence. Documentation and web retrieval obey the same information restrictions as other tools; the [adapter observation contract](../runtime-contracts.md) prevents them from bypassing game permissions.
