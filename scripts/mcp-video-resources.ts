import type { McpToolDefinition } from "./mcp-server.ts";
import { formatResponse, isRecord } from "./mcp-message-projection.ts";
import { listWorkspaceVideos, readWorkspaceVideo, VideoResourceError } from "./advance-video-pipe.mjs";

export const videoRenderTool: McpToolDefinition = {
  name: "advance-video-pipe_render_scene_plan",
  description: "Render an authorized JSON scene plan from this MCP process's trusted local video workspace and return an artifact URI plus verified duration, width and height. Use resources/read to open the MP4. Only relative plan paths are accepted; never provide a host absolute path.",
  inputSchema: {
    type: "object",
    properties: {
      plan_path: { type: "string", description: "Workspace-relative JSON scene plan, e.g. scenes/storyboard.json. The plan's PNG/JPEG images must stay inside its directory." },
    },
    required: ["plan_path"],
    additionalProperties: false,
  },
};

export async function respondToVideoResource(id: string | number | null, method: "resources/list" | "resources/read", params: unknown) {
  try {
    if (method === "resources/list") return formatResponse(id, await listWorkspaceVideos());
    if (!isRecord(params) || typeof params.uri !== "string") {
      return formatResponse(id, undefined, { code: -32602, message: "Invalid params: resources/read requires uri" });
    }
    return formatResponse(id, await readWorkspaceVideo(params.uri));
  } catch (error) {
    if (error instanceof VideoResourceError) return formatResponse(id, undefined, error);
    if (method === "resources/read" && isRecord(error) && error.code === "ENOENT") {
      return formatResponse(id, undefined, VideoResourceError.notFound());
    }
    return formatResponse(id, undefined, { code: -32603, message: "Could not access video resources in the selected workspace" });
  }
}
