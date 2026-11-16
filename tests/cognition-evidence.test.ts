import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core/types";
import type { Context } from "@oh-my-pi/pi-ai";
import { projectCognitionEvidence } from "../src/server/cognition-evidence.ts";
import type { CognitionEvidenceEvent } from "../src/server/cognition-ports.ts";
import type { CognitionMetadata } from "../src/server/cognition-protocol.ts";
import { cognitionMetadataBatchSchema } from "../src/server/cognition-protocol.ts";
import { COGNITION_LIMITS } from "../src/server/cognition-wire.ts";

const contextKind = "sdk_context_before_request_assembly_not_wire_payload";
const image = (data = "aGVsbG8=", mimeType = "image/png") => ({ type: "image" as const, data, mimeType });
const reference = (data = "aGVsbG8=", mimeType = "image/png") => ({
  type: "image_reference", mimeType, base64_chars: data.length,
  base64_sha256: createHash("sha256").update(data, "utf8").digest("hex"),
});

test("repeated large SDK images fit the unchanged metadata ceiling without dropping diagnostic records", () => {
  // Same base64 length as a 1,027,186-byte encoded observation, without loading a native frame.
  const data = "YWJj".repeat(342_395) + "ZA==";
  const part = image(data), expectedPart = reference(data);
  const context = {
    systemPrompt: ["Keep every diagnostic record."],
    messages: [
      { role: "user", content: [{ type: "text", text: "Image before tool execution." }, part], timestamp: 1 },
      { role: "toolResult", toolCallId: "call-1", toolName: "fixture_image", content: [
        { type: "text", text: "Image tool result." }, part, part,
      ], details: { sequence: 7, retained: true }, isError: false, timestamp: 2 },
    ],
  } satisfies Context;
  const events = [
    { type: "message_start", message: context.messages[1]! },
    { type: "message_end", message: context.messages[1]! },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "fixture_image",
      result: { content: context.messages[1]!.content, details: { sequence: 7, retained: true } }, isError: false },
  ] satisfies AgentEvent[];
  const rawOperations = [
    { kind: "sdk_evidence", evidence_kind: contextKind, body: context },
    ...events.map(body => ({ kind: "sdk_evidence", evidence_kind: "visible_agent_event", body })),
  ];
  expect(Buffer.byteLength(JSON.stringify(rawOperations))).toBeGreaterThan(COGNITION_LIMITS.metadataBytes);
  const operations: CognitionMetadata[] = [
    { kind: "sdk_evidence", evidence_kind: contextKind, body: projectCognitionEvidence(contextKind, context) },
    ...events.map(body => ({ kind: "sdk_evidence" as const, evidence_kind: "visible_agent_event" as const,
      body: projectCognitionEvidence("visible_agent_event", body) })),
  ];
  const batch = { sequence: 1, operations };
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(COGNITION_LIMITS.metadataBytes);
  const delivered = cognitionMetadataBatchSchema.parse(JSON.parse(JSON.stringify(batch)));
  expect(delivered.operations).toHaveLength(rawOperations.length);
  expect<unknown>(delivered.operations[0]).toEqual({ kind: "sdk_evidence", evidence_kind: contextKind,
    body: { ...context, messages: [
      { ...context.messages[0], content: [{ type: "text", text: "Image before tool execution." }, expectedPart] },
      { ...context.messages[1], content: [{ type: "text", text: "Image tool result." }, expectedPart, expectedPart] },
    ] } });
  for (const [index, event] of events.entries()) {
    const projected = event.type === "tool_execution_end"
      ? { ...event, result: { ...event.result, content: [{ type: "text", text: "Image tool result." }, expectedPart, expectedPart] } }
      : { ...event, message: { ...event.message, content: [{ type: "text", text: "Image tool result." }, expectedPart, expectedPart] } };
    expect<unknown>(delivered.operations[index + 1]).toEqual({ kind: "sdk_evidence", evidence_kind: "visible_agent_event", body: projected });
  }
  expect(part).toEqual(image(data));
  expect(context.messages[0]!.content[1]).toBe(part);
  expect(context.messages[1]!.content[1]).toBe(part);
  expect(context.messages[1]!.content[2]).toBe(part);
});

test("only direct image content parts change; tool arguments, details and arbitrary nested JSON remain exact", () => {
  const literal = { type: "image", data: "literal user argument", mimeType: "image/custom" };
  const argumentsValue = { image: literal, content: [literal], messages: [{ content: [literal] }] };
  const toolCall = { type: "toolCall", id: "call-1", name: "fixture_echo", arguments: argumentsValue };
  const text = { type: "text", text: "Image-shaped arguments must remain literal.", metadata: literal };
  const thinking = { type: "thinking", thinking: "Retained reasoning", thinkingSignature: "opaque-signature" };
  const body = {
    systemPrompt: ["Retained system prompt"],
    messages: [
      { role: "user", content: "Plain string content stays a string." },
      { role: "assistant", content: [thinking, toolCall, image(), text], details: { content: [literal] } },
      { role: "toolResult", content: [image("AQID", "image/webp"), text], details: argumentsValue },
    ],
    tools: [{ name: "fixture_echo", parameters: argumentsValue }],
    nested: { messages: [{ content: [image()] }] },
    content: [image()],
  };
  const before = JSON.stringify(body);
  expect<unknown>(projectCognitionEvidence(contextKind, body)).toEqual({
    ...body,
    messages: [
      body.messages[0],
      { ...body.messages[1], content: [thinking, toolCall, reference(), text] },
      { ...body.messages[2], content: [reference("AQID", "image/webp"), text] },
    ],
  });
  expect(JSON.stringify(body)).toBe(before);
});

test("visible message events project their message content, not adjacent or nested image lookalikes", () => {
  const literal = image("literal user argument");
  for (const type of ["message_start", "message_end"] as const) {
    const message = { role: "assistant", content: [
      { type: "toolCall", id: "call-1", name: "fixture_echo", arguments: { content: [literal] } }, image(),
    ], details: { content: [literal] } };
    const event = { type, message, result: { content: [literal] }, content: [literal] };
    const before = JSON.stringify(event);
    expect<unknown>(projectCognitionEvidence("visible_agent_event", event)).toEqual({
      ...event, message: { ...message, content: [message.content[0], reference()] },
    });
    expect(JSON.stringify(event)).toBe(before);
  }
});

test("visible tool completion projects result content but preserves details, errors and arguments", () => {
  const literal = image("literal result detail");
  const event = { type: "tool_execution_end", toolCallId: "call-1", toolName: "fixture_image", isError: true,
    result: { content: [{ type: "text", text: "Retained error text" }, image()], details: { content: [literal], error: "retained" } },
    args: { content: [literal] }, message: { content: [literal] } };
  const before = JSON.stringify(event);
  expect<unknown>(projectCognitionEvidence("visible_agent_event", event)).toEqual({
    ...event, result: { ...event.result, content: [event.result.content[0], reference()] },
  });
  expect(JSON.stringify(event)).toBe(before);
});

test("image references hash the original base64 text rather than decoded image bytes", () => {
  const data = "aGVsbG8=";
  const projected = projectCognitionEvidence(contextKind, { messages: [{ content: [image(data, "image/webp")] }] });
  const expected = reference(data, "image/webp");
  expect(expected.base64_sha256).not.toBe(createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"));
  expect(projected).toEqual({ messages: [{ content: [expected] }] });
  expect(projectCognitionEvidence(contextKind, { messages: [{ content: [image("")] }] }))
    .toEqual({ messages: [{ content: [reference("")] }] });
});

test("authoritative final context and other evidence kinds retain exact image bytes in detached snapshots", () => {
  const body = { messages: [{ role: "user", content: [image()] }],
    type: "message_end", message: { content: [image()] }, result: { content: [image()] } };
  for (const kind of ["final_sdk_visible_context_not_wire_payload", "coverage", "future_evidence_kind"] as const) {
    const source = structuredClone(body);
    const snapshot = projectCognitionEvidence(kind as CognitionEvidenceEvent["kind"], source);
    expect(snapshot).toEqual(body);
    expect(snapshot).not.toBe(source);
    source.messages[0]!.content[0]!.data = "changed live bytes";
    source.message.content.push(image("new live image"));
    expect(snapshot).toEqual(body);
  }
});

test("unsupported event types and malformed image lookalikes remain diagnostic data, not image references", () => {
  const malformed = [{ type: "image", data: 3, mimeType: "image/png" }, { type: "image", data: "literal" },
    { type: "image_reference", data: "literal", mimeType: "image/png" }];
  const context = { messages: [{ content: malformed }, { content: "plain content" }, null] };
  expect<unknown>(projectCognitionEvidence(contextKind, context)).toEqual(context);
  for (const type of ["tool_execution_start", "message_update", "turn_end", "agent_end", "future_event"]) {
    const body = { type, args: { content: [image()] }, message: { content: [image()] },
      result: { content: [image()] }, messages: [{ content: [image()] }] };
    expect(projectCognitionEvidence("visible_agent_event", body)).toEqual(body);
  }
});

test("diagnostic snapshots detach nonimage state and follow finite JSON serialization semantics", () => {
  const detail = { sequence: 1, values: [null, false, 0, "retained"], omitted: undefined,
    nonfinite: Number.POSITIVE_INFINITY };
  const source = { messages: [{ content: [image(), { type: "text", text: "retained" }], details: detail }] };
  const snapshot = projectCognitionEvidence(contextKind, source);
  const expected = { messages: [{ content: [reference(), { type: "text", text: "retained" }],
    details: { sequence: 1, values: [null, false, 0, "retained"], nonfinite: null } }] };
  expect(snapshot).toEqual(expected);
  detail.sequence = 99;
  detail.values.push("new live state");
  source.messages[0]!.content.push(image("new live image"));
  expect(snapshot).toEqual(expected);
  expect(projectCognitionEvidence("coverage", null)).toBeNull();
  expect(projectCognitionEvidence("coverage", [undefined, Number.NaN, "retained"])).toEqual([null, null, "retained"]);
  expect(() => projectCognitionEvidence("coverage", undefined)).toThrow(TypeError);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => projectCognitionEvidence(contextKind, cyclic)).toThrow(TypeError);
});
