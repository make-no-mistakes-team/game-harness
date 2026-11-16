import { createHash } from "node:crypto";
import type { Json } from "../shared/contracts.ts";
import type { CognitionEvidenceEvent } from "./cognition-ports.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectContent(owner: unknown): unknown {
  if (!isRecord(owner) || !Array.isArray(owner.content)) return owner;
  return { ...owner, content: owner.content.map(part => {
    if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string")
      return part;
    return { type: "image_reference", mimeType: part.mimeType, base64_chars: part.data.length,
      base64_sha256: createHash("sha256").update(part.data, "utf8").digest("hex") };
  }) };
}

/** Diagnostic copies only; SDK inputs and authoritative final context keep their image bytes. */
export function projectCognitionEvidence(kind: CognitionEvidenceEvent["kind"], body: unknown): Json {
  let projected = body;
  if (isRecord(body)) {
    if (kind === "sdk_context_before_request_assembly_not_wire_payload" && Array.isArray(body.messages))
      projected = { ...body, messages: body.messages.map(projectContent) };
    else if (kind === "visible_agent_event") {
      if (body.type === "message_start" || body.type === "message_end")
        projected = { ...body, message: projectContent(body.message) };
      else if (body.type === "tool_execution_end")
        projected = { ...body, result: projectContent(body.result) };
    }
  }
  // Serialize after projection, without first copying the raw image-bearing JSON.
  const json = JSON.stringify(projected);
  if (json === undefined) throw new TypeError("Cognition evidence must have a JSON representation");
  return JSON.parse(json) as Json;
}
