# Architecture

## Request flow

1. Alexa sends a signed request to `alexa-webhook`.
2. The function validates the Amazon certificate URL, chain, signature, timestamp and Skill ID.
3. `register_alexa_request` rejects replayed request IDs.
4. The interaction intent is converted into a natural-language question.
5. The key manager selects an available LLM credential.
6. The LLM either answers directly or requests one read-only tool.
7. The tool selects its own provider credential and runs under the shared request deadline.
8. A short voice-safe response and limited session context are returned to Alexa.

## Trust boundaries

- Alexa authentication is independent from Supabase JWT authentication.
- The service-role credential remains inside the Edge Function runtime.
- Provider credentials are returned only to service-role RPC callers.
- Scraping accepts only public HTTP(S) URLs and blocks common private-network targets.
- The agent may call at most one tool per turn.

## Runtime budget

The default request deadline is 7.2 seconds. Calls use smaller individual caps so the function can still return a valid Alexa response when a provider is slow.

## Configuration

Private installation values are environment variables. Public provider base URLs are centralized in `supabase/functions/alexa-webhook/config.ts`; LLM base URLs are database configuration in `key_manager.llm_providers`.

## Data model

The schema contains optional user, conversation, message, note and reminder tables. The current voice prototype does not create users or persist conversation messages. It stores only execution logs, replay receipts and the short Alexa session context.
