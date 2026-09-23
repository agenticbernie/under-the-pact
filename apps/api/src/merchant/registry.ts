import { Effect, Option } from "effect"
import type { MerchantConfig } from "@pact/shared"
import { PactConfigService } from "../config.js"

/**
 * BER-133 / C-004 Merchant Registry: the one pre-registered merchant.
 *
 * Structural guarantee behind "arbitrary recipients are not accepted":
 * this module exposes NO function that takes a wallet address as input.
 * The only recipient that can ever flow out is the configured merchant
 * wallet. Policy (BER-134/135) and preflight (BER-139) consume it from here.
 */
export class MerchantRegistry extends Effect.Service<MerchantRegistry>()(
  "MerchantRegistry",
  {
    effect: Effect.gen(function* () {
      const cfg = yield* PactConfigService
      const merchant: MerchantConfig = cfg.merchant
      return {
        /** The single registered merchant (throws if misconfigured). */
        getMerchant: () => merchant,
        /** Some(merchant) only for the registered id, None otherwise. */
        findMerchant: (
          merchantId: string
        ): Option.Option<MerchantConfig> =>
          merchant.active && merchant.merchantId === merchantId
            ? Option.some(merchant)
            : Option.none(),
        /** The only recipient the PoC will ever pay. No address parameter. */
        resolveRecipient: () => merchant.recipientWallet,
        isActive: () => merchant.active
      }
    })
  }
) {}

export const MerchantRegistryLive = MerchantRegistry.Default
