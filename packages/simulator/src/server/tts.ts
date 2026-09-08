import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";
import { config } from "./config.js";

/**
 * Text to speech for typed turns with Amazon Polly. Joanna is the voice the
 * original US Alexa was built from, so it is the "classic Alexa" sound; the
 * generative engine is its newest rendition. The browser falls back to
 * speechSynthesis if this fails.
 *
 *   POLLY_VOICE   Joanna | Danielle | Ruth | Salli | Matthew | Stephen | Tiffany  (default Joanna)
 *   POLLY_ENGINE  generative | neural | long-form                                   (default generative)
 */
const polly = new PollyClient({ region: config.region });
const voice = (process.env.POLLY_VOICE ?? "Joanna") as VoiceId;
const engine = (process.env.POLLY_ENGINE ?? "generative") as "generative" | "neural" | "long-form";

const cache = new Map<string, Uint8Array>();

/** Polly's PCM output is 16-bit mono at this rate (pcm supports 8000/16000 only). */
export const PCM_RATE = 16000;

/** Synthesize `text`; "mp3" for the browser <audio> path, "pcm" for the live voice channel. */
export async function synthesize(text: string, format: "mp3" | "pcm" = "mp3"): Promise<Uint8Array> {
  const key = `${voice}:${engine}:${format}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // Light SSML so error codes and model numbers are spelled out ("E24" -> "E two four").
  const ssml = `<speak>${escape(text).replace(/\b([A-Z]{1,2}\d{1,3})\b/g, '<say-as interpret-as="characters">$1</say-as>')}</speak>`;
  const res = await polly.send(
    new SynthesizeSpeechCommand({
      Engine: engine,
      VoiceId: voice,
      OutputFormat: format,
      SampleRate: format === "pcm" ? String(PCM_RATE) : undefined,
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
