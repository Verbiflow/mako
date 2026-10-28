import { useCallback, useEffect, useRef, useState } from "react"

/** The browser's speech recognition, as Chrome and Safari name it: only what the composer uses. */
interface Recognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: RecognitionResults) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}
interface RecognitionResults {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}
type RecognitionClass = new () => Recognition

declare global {
  interface Window {
    SpeechRecognition?: RecognitionClass
    webkitSpeechRecognition?: RecognitionClass
  }
}

function recognitionClass(): RecognitionClass | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition
}

/** Whether this browser recognizes speech itself: Chrome on Android, Safari on an iPhone (14.5 on). */
export function dictationOffered(): boolean {
  return recognitionClass() !== undefined
}

/** The words heard so far: the settled ones, and the ones still being heard. */
export interface Heard {
  final: string
  interim: string
}

/**
 * Dictation into the composer by the platform's own recognizer, the one its keyboard's dictation uses: no sound goes
 * anywhere else. `start` listens in the page's language; each result says the words heard so far; `stop` settles them.
 * Ends on its own when the person stops talking long enough, as the platform decides.
 */
export function useDictation(onHeard: (heard: Heard) => void): { offered: boolean; listening: boolean; failure?: string; start: () => void; stop: () => void } {
  const [listening, setListening] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const recognition = useRef<Recognition | null>(null)
  const heard = useRef(onHeard)
  useEffect(() => {
    heard.current = onHeard
  }, [onHeard])
  useEffect(() => () => recognition.current?.abort(), [])
  const start = useCallback(() => {
    const Class = recognitionClass()
    if (!Class || recognition.current) return
    const listener = new Class()
    listener.lang = navigator.language
    listener.continuous = true
    listener.interimResults = true
    const finals: string[] = []
    listener.onresult = (event) => {
      let interim = ""
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]!
        if (result.isFinal) finals[index] = result[0].transcript.trim()
        else interim += result[0].transcript
      }
      heard.current({ final: finals.filter(Boolean).join(" "), interim: interim.trim() })
    }
    listener.onerror = (event) => {
      // "no-speech" and "aborted" are a quiet end, not a failure to tell anyone about.
      if (event.error !== "no-speech" && event.error !== "aborted") setFailure(event.error === "not-allowed" ? "Allow the microphone to dictate." : "Dictation stopped.")
    }
    listener.onend = () => {
      recognition.current = null
      setListening(false)
    }
    setFailure(undefined)
    recognition.current = listener
    try {
      listener.start()
      setListening(true)
    } catch {
      recognition.current = null
      setFailure("Dictation isn't available right now.")
    }
  }, [])
  const stop = useCallback(() => recognition.current?.stop(), [])
  return failure ? { offered: dictationOffered(), listening, failure, start, stop } : { offered: dictationOffered(), listening, start, stop }
}
