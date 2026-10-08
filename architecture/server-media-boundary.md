# Server media model boundary

Image, video, TTS and ASR requests resolve the effective wire model before taking an operator credential. `resolveMediaProviderConfig` is the common boundary for direct generation, image/video verification and automatic classroom generation.

An absent `models` field preserves the existing unrestricted behavior. An explicit empty list denies operator requests; malformed list values also deny. A configured `provider:model` entry authorizes its raw model for that provider only. A client request does not acquire authorization by adding a provider prefix. Omitted client models are checked using the existing adapter default. Fixed-model audio backends and VoxCPM aliases are checked against their actual wire model/resource instead of an ignored request field.

BYOK retains its existing endpoint/model behavior. A client base URL receives only the client key, including when the URL matches an operator URL. Server-configured endpoints remain operator configuration. OpenAI image fallback retains its shared `OPENAI_API_KEY` behavior while applying `IMAGE_OPENAI_MODELS`.

Automatic classroom generation chooses the first configured allowed model instead of an unrestricted UI registry default. Denied media is soft-skipped without provider calls or output writes. MiniMax connectivity checks send the same model that was authorized. Route denials return the existing error envelope with HTTP 403 before provider work. OpenMAIC's supported provider set is retained; no HyperClass-only provider or lesson pipeline is added.

Tests call the real route/resolution and adapter code with synthetic credentials and a mocked upstream; they do not demonstrate live provider quality or a production deployment. This change has no database or public API migration. Reverting its product commit restores the prior behavior; retain the tests and original failure evidence for audit.
