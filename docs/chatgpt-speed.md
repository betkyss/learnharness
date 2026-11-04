# ChatGPT subscription speed

The Speed menu controls processing speed separately from Thinking. It appears for the ChatGPT subscription provider in conversation controls and Settings → Agent.

- Standard requests `service_tier: "default"`.
- Fast requests `service_tier: "priority"`.
- Ultrafast requests `service_tier: "ultrafast"` and is offered only for `gpt-6.1-sol` and `gpt-6-astra`.

A chat's explicit speed wins over Strong. A worker's explicit speed wins over its Cheap or Vision slot. An unset speed inherits; the final default is Standard. The worker menu can clear its override with Use Cheap or Use Vision. PDF Reader has its own override and otherwise uses Vision.

Model changes preserve a supported speed. An incompatible inherited preference resolves to Standard, and other providers receive no speed option. Explicit unsupported settings writes return an error. Changing Thinking or the model preserves other applicable settings.

The ChatGPT adapter sets the tier after its final payload filter, including subsequent requests after tool results. It uses the same subscription authorization and never retries with another speed or an API key. The provider can reject a tier for the connected account; selecting a tier is not a guarantee that the subscription permits it. Record the returned `service_tier`, but do not use it alone to decide whether this subscription flow applied a speed change. Controlled local measurements found distinct streaming rates for Standard, Fast and Ultrafast while all three responses reported `default`. Compare repeated equal-output requests at the same reasoning effort, and keep time to first token separate from streaming throughput. These measurements do not guarantee future latency or identify the backend routing tier.

Focused checks are in `tests/model-speed.test.ts` and `tests/chatgpt-stream.test.ts`. The latter runs all worker role selections through real agent loops against a captured fake transport, including tool continuation, for both Ultrafast-capable models and all three speeds. These checks prove request construction and isolation, not live account entitlement.
