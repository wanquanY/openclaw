import type { SavedMedia } from "../../media/store.js";
import { saveMediaBuffer, saveMediaSource } from "../../media/store.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export type RpcAttachmentRefInput = {
  type?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
  size?: unknown;
  fileId?: unknown;
  previewUrl?: unknown;
  source?: unknown;
};

export type ChatAttachmentRef = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  fileId?: string;
  previewUrl?: string;
  source:
    | {
        type: "url";
        url: string;
        headers?: Record<string, string>;
      }
    | {
        type: "base64";
        data: string;
        mediaType?: string;
      }
    | {
        type: "file";
        path: string;
      };
};

function normalizeBase64Content(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim();
  }
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("base64");
  }
  if (content instanceof ArrayBuffer) {
    return Buffer.from(content).toString("base64");
  }
  return undefined;
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const headerName = key.trim();
    const headerValue = normalizeOptionalString(value);
    if (!headerName || !headerValue) {
      continue;
    }
    // This RPC is only used by trusted desktop/web clients. Keep the allowlist
    // intentionally small so bearer credentials do not accidentally persist or
    // propagate as general-purpose fetch headers.
    if (!/^authorization$/i.test(headerName) && !/^x-/i.test(headerName)) {
      continue;
    }
    normalized[headerName] = headerValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeAttachmentRef(
  input: RpcAttachmentRefInput | undefined,
): ChatAttachmentRef | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const source =
    input.source && typeof input.source === "object" && !Array.isArray(input.source)
      ? (input.source as Record<string, unknown>)
      : undefined;
  if (!source) {
    return null;
  }
  const sourceType = normalizeOptionalString(source.type);
  const url = normalizeOptionalString(source.url);
  const filePath =
    sourceType === "file"
      ? (normalizeOptionalString(source.path) ?? normalizeOptionalString(source.filePath))
      : undefined;
  const sourceData =
    sourceType === "base64" ? normalizeBase64Content(source.data ?? source.content) : undefined;
  if (sourceType !== "url" && sourceType !== "base64" && sourceType !== "file") return null;
  if (sourceType === "url" && !url) return null;
  if (sourceType === "base64" && !sourceData) return null;
  if (sourceType === "file" && !filePath) return null;
  const size =
    typeof input.size === "number" && Number.isFinite(input.size)
      ? Math.max(0, Math.floor(input.size))
      : undefined;
  const sourceUrl = url ?? "";
  const normalized: ChatAttachmentRef = {
    type: normalizeOptionalString(input.type),
    mimeType: normalizeOptionalString(input.mimeType),
    fileName: normalizeOptionalString(input.fileName),
    size,
    fileId: normalizeOptionalString(input.fileId),
    previewUrl: normalizeOptionalString(input.previewUrl),
    source:
      sourceType === "url"
        ? {
            type: "url",
            url: sourceUrl,
            headers: normalizeHeaders(source.headers),
          }
        : sourceType === "base64"
          ? {
              type: "base64",
              data: sourceData ?? "",
              mediaType:
                normalizeOptionalString(source.mediaType) ??
                normalizeOptionalString(source.media_type) ??
                normalizeOptionalString(input.mimeType),
            }
          : {
              type: "file",
              path: filePath ?? "",
            },
  };
  return normalized;
}

export function normalizeRpcAttachmentRefs(
  refs: RpcAttachmentRefInput[] | undefined,
): ChatAttachmentRef[] {
  return (
    refs
      ?.map((ref) => normalizeAttachmentRef(ref))
      .filter((ref): ref is ChatAttachmentRef => Boolean(ref)) ?? []
  );
}

export async function stageChatAttachmentRefs(params: {
  refs: ChatAttachmentRef[];
  maxBytes?: number;
  log?: { warn?: (message: string) => void; info?: (message: string) => void };
}): Promise<SavedMedia[]> {
  const maxBytes = params.maxBytes ?? 5_000_000;
  const saved: SavedMedia[] = [];
  const failures: string[] = [];
  for (const ref of params.refs) {
    const label =
      ref.fileId ||
      ref.fileName ||
      (ref.source.type === "url"
        ? ref.source.url
        : ref.source.type === "file"
          ? ref.source.path
          : "base64");
    try {
      let media: SavedMedia;
      if (ref.source.type === "url") {
        media = await saveMediaSource(ref.source.url, ref.source.headers, "inbound", maxBytes);
      } else if (ref.source.type === "file") {
        media = await saveMediaSource(ref.source.path, undefined, "inbound", maxBytes);
      } else {
        media = await saveMediaBuffer(
          Buffer.from(ref.source.data, "base64"),
          ref.source.mediaType || ref.mimeType || "application/octet-stream",
          "inbound",
          maxBytes,
          ref.fileName,
        );
      }
      saved.push(media);
      params.log?.info?.(`chat.send: staged attachment ref ${label} -> ${media.path}`);
    } catch (err) {
      params.log?.warn?.(`chat.send: failed to stage attachment ref ${label}: ${String(err)}`);
      failures.push(`${label}: ${String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `failed to stage ${failures.length}/${params.refs.length} attachment refs: ${failures.join("; ")}`,
    );
  }
  return saved;
}
