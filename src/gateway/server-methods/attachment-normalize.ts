import type { ChatAttachment } from "../chat-attachments.js";

export type RpcAttachmentInput = {
  type?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
  content?: unknown;
  previewContent?: unknown;
  previewMimeType?: unknown;
};

export function normalizeRpcAttachmentsToChatAttachments(
  attachments: RpcAttachmentInput[] | undefined,
): ChatAttachment[] {
  return (
    attachments
      ?.map((a) => ({
        type: typeof a?.type === "string" ? a.type : undefined,
        mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
        fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
        content:
          typeof a?.content === "string"
            ? a.content
            : ArrayBuffer.isView(a?.content)
              ? Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength).toString(
                  "base64",
                )
              : a?.content instanceof ArrayBuffer
                ? Buffer.from(a.content).toString("base64")
                : undefined,
        previewContent:
          typeof a?.previewContent === "string"
            ? a.previewContent
            : ArrayBuffer.isView(a?.previewContent)
              ? Buffer.from(
                  a.previewContent.buffer,
                  a.previewContent.byteOffset,
                  a.previewContent.byteLength,
                ).toString("base64")
              : a?.previewContent instanceof ArrayBuffer
                ? Buffer.from(a.previewContent).toString("base64")
                : undefined,
        previewMimeType: typeof a?.previewMimeType === "string" ? a.previewMimeType : undefined,
      }))
      .filter((a) => a.content) ?? []
  );
}
