import type { APIMasterClient, ResolverErrorCode } from "../clients/apimaster.js";
import { ResolverError } from "../clients/apimaster.js";
import { sameModelId } from "../settings/service.js";

export type GuestFallbackReason = Extract<ResolverErrorCode, "telegram_not_bound" | "no_usable_api_key">;

export interface ChatCredential {
  apiKey: string;
  model: string;
  source: "user" | "guest";
  fallbackReason: GuestFallbackReason | null;
}

export interface ChatCredentialProvider {
  resolve(telegramUserId: number, requestedModel: string, fallbackUserModel?: string): Promise<ChatCredential>;
}

interface GuestCredentialOptions {
  apiKey: string;
  model: string | (() => string);
}

export class ChatCredentialResolver implements ChatCredentialProvider {
  constructor(
    private readonly client: Pick<APIMasterClient, "resolveAPIKey">,
    private readonly guest: GuestCredentialOptions,
  ) {}

  async resolve(
    telegramUserId: number,
    requestedModel: string,
    fallbackUserModel?: string,
  ): Promise<ChatCredential> {
    try {
      return {
        apiKey: await this.client.resolveAPIKey(telegramUserId, requestedModel),
        model: requestedModel,
        source: "user",
        fallbackReason: null,
      };
    } catch (error) {
      if (!(error instanceof ResolverError) || !isGuestFallback(error.code)) throw error;
      if (error.code === "no_usable_api_key" && fallbackUserModel &&
          !sameModelId(requestedModel, fallbackUserModel)) {
        try {
          return {
            apiKey: await this.client.resolveAPIKey(telegramUserId, fallbackUserModel),
            model: fallbackUserModel,
            source: "user",
            fallbackReason: null,
          };
        } catch (fallbackError) {
          if (!(fallbackError instanceof ResolverError) || !isGuestFallback(fallbackError.code)) {
            throw fallbackError;
          }
          return this.guestCredential(fallbackError.code);
        }
      }
      return this.guestCredential(error.code);
    }
  }

  private guestCredential(fallbackReason: GuestFallbackReason): ChatCredential {
    return {
      apiKey: this.guest.apiKey,
      model: typeof this.guest.model === "function" ? this.guest.model() : this.guest.model,
      source: "guest",
      fallbackReason,
    };
  }
}

function isGuestFallback(code: ResolverErrorCode): code is GuestFallbackReason {
  return code === "telegram_not_bound" || code === "no_usable_api_key";
}
