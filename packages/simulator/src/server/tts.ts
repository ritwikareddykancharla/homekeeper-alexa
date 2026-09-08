import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";
import { config } from "./config.js";

/**
 * Text to speech with Amazon Polly generative voices (the neural family Alexa
 * itself speaks with). The browser falls back to speechSynthesis if this fails.
 *
 *   POLLY_VOICE   Danielle | Joanna | Ruth | Salli | Matthew | Stephen | Tiffany  (default Danielle)
 *   POLLY_ENGINE  generative | neural | long-form                                   (default generative)
 */
const polly = new PollyClient({ region: config.region });
const voice = (process.env.POLLY_VOICE ?? "Danielle") as VoiceId;
const engine = (process.env.POLLY_ENGINE ?? "generative") as "generative" | "neural" | "long-form";

const cache = new Map<string, Uint8Array>();

export async function synthesize(text: string): Promise<Uint8Array> {
  const key = `${voice}:${engine}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // Light SSML so error codes and model numbers are spelled out ("E24" -> "E two four").
  const ssml = `<speak>${escape(text).replace(/\b([A-Z]{1,2}\d{1,3})\b/g, '<say-as interpret-as="characters">$1</say-as>')}</speak>`;
  const res = await polly.send(
    new SynthesizeSpeechCommand({
      Engine: engine,
      VoiceId: voice,
      OutputFormat: "mp3",
      TextType: "ssml",
      Text: ssml
    })
  );
  const bytes = await res.AudioStream!.transformToByteArray();
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, bytes);
  return bytes;
}

export const ttsInfo = { provider: "polly", voice, engine };

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
