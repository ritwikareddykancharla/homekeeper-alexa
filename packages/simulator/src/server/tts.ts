import { DescribeVoicesCommand, PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from "@aws-sdk/client-polly";
import { config } from "./config.js";

/**
 * Text to speech with Amazon Polly. Default is Ruth on the generative engine,
 * the warmest and most expressive of the en-US voices in a side-by-side test.
 * Joanna is the voice the original US Alexa was built from if you want the
 * "classic Alexa" sound. The voice can be switched at runtime from the
 * simulator UI (POST /api/voice).
 *
 *   POLLY_VOICE   Ruth | Joanna | Danielle | Salli | Matthew | Stephen | Tiffany | ...  (default Ruth)
 *   POLLY_ENGINE  generative | long-form | neural                                     (default generative)
 */
const polly = new PollyClient({ region: config.region });

type TtsEngine = "generative" | "long-form" | "neural";
const current = {
  voice: (process.env.POLLY_VOICE ?? "Ruth") as VoiceId,
  engine: (process.env.POLLY_ENGINE ?? "generative") as TtsEngine
};

export interface VoiceOption {
  id: string;
  name: string;
  gender: string;
  engine: TtsEngine;
}

let voiceList: VoiceOption[] | undefined;

/** en-US voices per engine, most expressive engines first. Cached after the first call. */
export async function listVoices(): Promise<VoiceOption[]> {
  if (voiceList) return voiceList;
  const out: VoiceOption[] = [];
  for (const engine of ["generative", "long-form", "neural"] as TtsEngine[]) {
    try {
      const res = await polly.send(new DescribeVoicesCommand({ Engine: engine as Engine, LanguageCode: "en-US" }));
      for (const v of res.Voices ?? []) out.push({ id: v.Id!, name: v.Name ?? v.Id!, gender: v.Gender ?? "", engine });
    } catch (err) {
      console.warn(`[tts] could not list ${engine} voices: ${(err as Error).message}`);
    }
  }
  voiceList = out;
  return out;
}

export async function setVoice(voice: string, engine: TtsEngine): Promise<void> {
  const ok = (await listVoices()).some((v) => v.id === voice && v.engine === engine);
  if (!ok) throw new Error(`${voice} is not available on the ${engine} engine`);
  current.voice = voice as VoiceId;
  current.engine = engine;
  cache.clear();
}

export const ttsInfo = {
  provider: "polly",
  get voice() {
    return current.voice as string;
  },
  get engine() {
    return current.engine;
  }
};

const cache = new Map<string, Uint8Array>();

/** Polly's PCM output is 16-bit mono at this rate (pcm supports 8000/16000 only). */
export const PCM_RATE = 16000;

/** Synthesize `text`; "mp3" for the browser <audio> path, "pcm" for the live voice channel. */
export async function synthesize(text: string, format: "mp3" | "pcm" = "mp3"): Promise<Uint8Array> {
  const key = `${current.voice}:${current.engine}:${format}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const res = await polly.send(
    new SynthesizeSpeechCommand({
      Engine: current.engine as Engine,
      VoiceId: current.voice,
      OutputFormat: format,
      SampleRate: format === "pcm" ? String(PCM_RATE) : undefined,
      TextType: "ssml",
      Text: toSsml(text)
    })
  );
  const bytes = await res.AudioStream!.transformToByteArray();
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, bytes);
  return bytes;
}

/**
 * Light SSML that every Polly engine accepts: explicit sentence boundaries so
 * intonation resets per sentence, a beat after short interjections ("Oh,"
 * "Good news:"), and error codes / model numbers spelled out ("E24" -> "E two four").
 */
function toSsml(text: string): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .filter(Boolean);
  const body = sentences
    .map((s) => {
      let x = escape(s).replace(/\b([A-Z]{1,2}\d{1,3})\b/g, '<say-as interpret-as="characters">$1</say-as>');
      // "Oh, ..." / "Good news: ..." / "Okay. ..." get a short beat so they land as a reaction.
      x = x.replace(/^((?:Oh|Ah|Okay|OK|Right|Sure|Good news|Bad news|Hmm|Well|Got it|Done|Great)[,:!.]?)\s/, '$1<break time="180ms"/> ');
      return `<s>${x}</s>`;
    })
    .join("");
  return `<speak>${body}</speak>`;
}

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
