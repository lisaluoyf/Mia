import type { ConversationContext } from "../context/conversation.js";
import { promptReference } from "../prompts.js";
import type { DebugContextLayers } from "./types.js";

function mediaRole(context: ConversationContext, messageId: number): "current" | "replied" | "active" | "historical" {
  if (messageId === context.currentMessageId) return "current";
  if (messageId === context.replyToMessageId) return "replied";
  if (messageId === context.activeMediaMessageId) return "active";
  return "historical";
}

export function debugContextLayers(context: ConversationContext): DebugContextLayers {
  return {
    systemRules: promptReference("mia.system"),
    conversation: {
      ...context.metadata,
      participants: context.participants.map((participant) => ({
        telegramUserId: participant.telegramUserId,
        displayName: [participant.firstName, participant.lastName].filter(Boolean).join(" "),
        username: participant.username,
      })),
    },
    longTermMemory: context.memories.map(({ scope, category, content, sourceMessageId, updatedAt }) => ({
      scope,
      category,
      content,
      sourceMessageId,
      updatedAt,
    })),
    rollingSummary: context.summary,
    recentMessages: {
      order: "oldest_to_newest",
      currentMessageId: context.currentMessageId,
      replyToMessageId: context.replyToMessageId,
      messages: context.messages.map((message) => ({
        messageId: message.messageId,
        senderUserId: message.senderUserId,
        replyToMessageId: message.replyToMessageId,
        contentType: message.contentType,
        text: message.text ?? message.caption,
        sentAt: message.sentAt,
        current: message.messageId === context.currentMessageId,
      })),
      media: context.mediaInputs.map((media) => ({
        position: media.position,
        messageId: media.messageId,
        type: media.type,
        mimeType: media.mimeType,
        reference: media.fileUniqueId ?? `message:${media.messageId}`,
        role: mediaRole(context, media.messageId),
      })),
    },
  };
}
