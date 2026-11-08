// Speech to text with the browser's own Web Speech API (SpeechRecognition). Nothing is downloaded or run here:
// Chrome and Edge send the audio to their speech service, so this needs an internet connection.
// The language is fixed to English, whatever the Windows display language is.

/** The recognition language: English (US). Change it here if you ever need another one. */
export const DICTATION_LANG = 'en-US';

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type RecognitionError = { error: string };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionError) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const dictationSupported = (): boolean => recognitionCtor() !== null;

/** What went wrong, in words for the composer's hint line. `null` for errors that need no message. */
function explain(error: string): string | null {
  switch (error) {
    case 'no-speech':
    case 'aborted':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone is blocked for this site. Allow it in the address bar and try again.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'Speech recognition could not reach its service. It needs an internet connection.';
    default:
      return `Speech recognition stopped: ${error}`;
  }
}

/**
 * Dictation for one text box. `onFinal` gets each recognised phrase once it is final.
 * Listening stops on `stop()`, on unmount, and when the browser gives up on an error;
 * it restarts itself when the browser ends a session on its own (it does so after a pause) while still wanted.
 */
export function createDictation(onFinal: (text: string) => void, onState: (state: { listening: boolean; error: string | null }) => void) {
  const Ctor = recognitionCtor();
  let rec: Recognition | null = null;
  let wanted = false;
  let listening = false;
  let error: string | null = null;
  const emit = () => onState({ listening, error });

  const start = () => {
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = DICTATION_LANG;
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          const said = result[0].transcript.trim();
          if (said) onFinal(said);
        }
      }
    };
    r.onerror = (e) => {
      error = explain(e.error);
      // Permission and service errors end the session for good; the browser also sends `end` after them.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') wanted = false;
      emit();
    };
    r.onend = () => {
      if (rec !== r) return;
      if (wanted) {
        try {
          r.start();
          return;
        } catch {
          // fall through: stop cleanly
        }
      }
      rec = null;
      wanted = false;
      listening = false;
      emit();
    };
    rec = r;
    listening = true;
    error = null;
    emit();
    try {
      r.start();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      rec = null;
      listening = false;
      wanted = false;
      emit();
    }
  };

  const controller = {
    toggle() {
      if (listening) controller.stop();
      else {
        wanted = true;
        start();
      }
    },
    /** Ends the session; the last phrase still arrives if the browser had it. */
    stop() {
      wanted = false;
      rec?.stop();
      if (!rec) {
        listening = false;
        emit();
      }
    },
    /** Drops the session at once (unmount, another agent). */
    abort() {
      wanted = false;
      const r = rec;
      rec = null;
      listening = false;
      r?.abort();
    },
  };
  return controller;
}
