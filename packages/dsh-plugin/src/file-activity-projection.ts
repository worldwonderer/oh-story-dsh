import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { z } from "zod";
import {
  FILE_ACTIVITY_PROJECTION_KEY,
  type FileActivityProjection,
  type ProjectedFileCall
} from "./file-activity-projection-types.js";

const callSchema = z.object({
  callId: z.string(),
  name: z.string(),
  argsRaw: z.string(),
  slot: z.string()
}).strict();
const projectionSchema: z.ZodType<FileActivityProjection> = z.object({ calls: z.array(callSchema) }).strict();
const FILE_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    ohStoryFileActivity: FileActivityProjection;
  }
  interface SessionProjectionMap {
    ohStoryFileActivity: FileActivityProjection;
  }
}

function replaceCall(calls: readonly ProjectedFileCall[], call: ProjectedFileCall): readonly ProjectedFileCall[] {
  const index = calls.findIndex((value) => value.slot === call.slot);
  if (index < 0) return [...calls, call];
  if (calls[index]?.callId === call.callId && calls[index]?.name === call.name && calls[index]?.argsRaw === call.argsRaw) return calls;
  const next = [...calls];
  next[index] = call;
  return next;
}

/** Publish only in-progress model tool arguments; settled file truth still comes from DSH FS. */
export const fileActivityProjectionDefinition = {
  key: FILE_ACTIVITY_PROJECTION_KEY,
  stateSchema: projectionSchema,
  init: (): FileActivityProjection => ({ calls: [] }),
  apply: (state: FileActivityProjection, event: SessionEvent): FileActivityProjection => {
    if (event.type === "assistant/chunk") {
      const chunk = event.data.chunk;
      if (chunk.type === "tool-call-delta") {
        const slot = `${String(event.data.turn)}:${String(event.data.step)}:${String(chunk.index)}`;
        const previous = state.calls.find((value) => value.slot === slot);
        const name = chunk.name ?? previous?.name;
        if (name === undefined || !FILE_TOOLS.has(name)) return state;
        return {
          calls: replaceCall(state.calls, {
            slot,
            callId: previous?.callId || String(chunk.id),
            name,
            argsRaw: `${previous?.argsRaw ?? ""}${chunk.argumentsDelta}`
          })
        };
      }
      if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
        if (!FILE_TOOLS.has(chunk.block.name)) return state;
        const slot = `${String(event.data.turn)}:${String(event.data.step)}:${String(chunk.index)}`;
        return {
          calls: replaceCall(state.calls, {
            slot,
            callId: String(chunk.block.id),
            name: chunk.block.name,
            argsRaw: chunk.block.arguments
          })
        };
      }
      return state;
    }
    if (event.type === "tool/call") {
      const calls = state.calls.filter((value) => value.callId !== String(event.data.callId));
      return calls.length === state.calls.length ? state : { calls };
    }
    if (event.type === "turn/end" && state.calls.length > 0) return { calls: [] };
    return state;
  },
  wire: { viewSchema: projectionSchema, view: (state: FileActivityProjection) => state },
  stateVersion: 1
} satisfies ProjectionDefinition<typeof FILE_ACTIVITY_PROJECTION_KEY, FileActivityProjection>;
