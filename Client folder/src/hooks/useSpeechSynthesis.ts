// src/hooks/useSpeechSynthesis.ts
import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080';

export interface BrowserSpeechSynthesisVoice extends SpeechSynthesisVoice {
  type: 'browser';
  uniqueId: string; 
}

export interface GoogleCloudVoice {
  name: string;
  language_codes: string[];
  ssml_gender: string;
  natural_sample_rate_hertz: number;
  type: 'google';
  supportsPitch?: boolean;
  uniqueId: string; 
}

export type CombinedVoice = BrowserSpeechSynthesisVoice | GoogleCloudVoice;

export interface SpeechSynthesisHook {
  speak: (text: string) => void;
  cancel: () => void;
  isSpeaking: boolean;
  isSupported: boolean;
  allVoices: CombinedVoice[];
  selectedVoiceIdentifier: string | null; // This will be the uniqueId
  setVoice: (uniqueId: string) => void;
  rate: number;
  setRate: (rate: number) => void;
  pitch: number;
  setPitch: (pitch: number) => void;
  isLoadingVoices: boolean;
  getSelectedVoiceInfo: () => CombinedVoice | undefined;
}

export const useSpeechSynthesis = (): SpeechSynthesisHook => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [isLoadingVoices, setIsLoadingVoices] = useState(true);
  const [allVoices, setAllVoices] = useState<CombinedVoice[]>([]);
  const [selectedVoiceIdentifier, setSelectedVoiceIdentifier] = useState<string | null>(null);
  const [rate, setRate] = useState(1.0);
  const [pitch, setPitch] = useState(1.0);

  const browserSpeechSynthesis = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechQueueRef = useRef<string | null>(null);

  const isSpeakingRef = useRef(isSpeaking);
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  const rateRef = useRef(rate);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  const pitchRef = useRef(pitch);
  useEffect(() => { pitchRef.current = pitch; }, [pitch]);

  const _doActualSpeakRef = useRef<(text: string) => Promise<void>>(async () => {});

  const _handleSpeechEnd = useCallback(() => {
    const queuedText = speechQueueRef.current;
    if (queuedText) {
        speechQueueRef.current = null;
        console.log(`[useSpeechSynthesis] Speech ended. Processing queued text: "${queuedText.substring(0, 30)}..."`);
        _doActualSpeakRef.current(queuedText); 
    } else {
        // Ensure isSpeaking is false if the queue is empty and speech truly ended.
        // The individual onended handlers for audio/utterance should also call setIsSpeaking(false).
        // This is a final safeguard.
        if(isSpeakingRef.current) { // Check ref to prevent unnecessary sets
            setIsSpeaking(false);
        }
        console.log("[useSpeechSynthesis] Speech ended. Queue is empty.");
    }
  }, []); // isSpeakingRef.current is used, setIsSpeaking is stable

  useEffect(() => {
    audioRef.current = new Audio();
    const currentAudioRef = audioRef.current;
    const handleAudioEnded = () => { setIsSpeaking(false); _handleSpeechEnd(); };
    const handleAudioError = (e: Event) => { console.error('[useSpeechSynthesis] Audio playback error:', e); setIsSpeaking(false); _handleSpeechEnd(); };
    currentAudioRef.addEventListener('ended', handleAudioEnded);
    currentAudioRef.addEventListener('error', handleAudioError);
    return () => {
        if (currentAudioRef) {
            currentAudioRef.pause(); currentAudioRef.src = '';
            currentAudioRef.removeEventListener('ended', handleAudioEnded);
            currentAudioRef.removeEventListener('error', handleAudioError);
        }
        if (browserSpeechSynthesis && browserSpeechSynthesis.speaking) browserSpeechSynthesis.cancel();
    };
  }, [browserSpeechSynthesis, _handleSpeechEnd]);

  useEffect(() => {
    const fetchVoices = async () => {
      setIsLoadingVoices(true);
      let browserVoicesMapped: BrowserSpeechSynthesisVoice[] = [];
      let googleVoicesMapped: GoogleCloudVoice[] = [];
      let browserTtsSupported = !!browserSpeechSynthesis;

      if (browserSpeechSynthesis) {
        const getBrowserVoices = (): Promise<BrowserSpeechSynthesisVoice[]> => {
          return new Promise(resolve => {
            let resolved = false;
            const filterAndMapValidVoices = (rawVoices: SpeechSynthesisVoice[] | undefined | null): BrowserSpeechSynthesisVoice[] => {
              console.log("[useSpeechSynthesis Debug] filterAndMapValidVoices: Raw input count:", rawVoices?.length);
              if (!rawVoices || rawVoices.length === 0) {
                console.log("[useSpeechSynthesis Debug] filterAndMapValidVoices: Input is null or empty, returning [].");
                return [];
              }
              
              const uniqueVoicesTemp: SpeechSynthesisVoice[] = [];
              const seenVoiceURIs = new Set<string>();

              for (const voice of rawVoices) {
                  if (voice && typeof voice.voiceURI === 'string' && voice.voiceURI.trim() !== '') {
                      if (!seenVoiceURIs.has(voice.voiceURI)) {
                          seenVoiceURIs.add(voice.voiceURI);
                          uniqueVoicesTemp.push(voice);
                      } else {
                          // console.log(`[useSpeechSynthesis Debug] Duplicate voiceURI found, primary: ${voice.voiceURI} for name ${voice.name}`);
                      }
                  } else if (voice && typeof voice.name === 'string' && voice.name.trim() !== '') {
                      // Fallback for voices without a unique URI but with a name (less ideal for Select key)
                      // Try to make a synthetic URI if really needed, or ensure name is unique enough for this path
                      // For now, let's prioritize URI-based uniqueness. If URI is missing, it might be problematic.
                      // console.warn(`[useSpeechSynthesis Debug] Voice has no URI, using name: ${voice.name}`);
                      // To avoid issues, we will primarily rely on voiceURI for uniqueness for browser voices
                      // If voiceURI is empty, it might not be a good candidate unless name is globally unique
                  }
              }
              console.log("[useSpeechSynthesis Debug] Raw unique browser voices after Set (by voiceURI):", uniqueVoicesTemp.length, uniqueVoicesTemp.map(v => ({name: v.name, uri: v.voiceURI})));

              const mapped: BrowserSpeechSynthesisVoice[] = [];
              uniqueVoicesTemp.forEach((v, index) => {
                // Stricter check: must have name AND voiceURI for browser voices to be useful as select options
                if (typeof v.name === 'string' && v.name.trim() !== '' &&
                    typeof v.voiceURI === 'string' && v.voiceURI.trim() !== '') {
                  // Prefix + voiceURI should be very unique. Add index just in case of extreme edge cases or if voiceURI isn't truly unique by browser.
                  const uniqueId = `browser_${v.voiceURI}_${index}`; 
                  mapped.push({
                    default: typeof v.default === 'boolean' ? v.default : false,
                    lang: typeof v.lang === 'string' ? v.lang : '',
                    localService: typeof v.localService === 'boolean' ? v.localService : false,
                    name: v.name,
                    voiceURI: v.voiceURI,
                    type: 'browser' as const,
                    uniqueId: uniqueId
                  });
                } else {
                    // console.warn(`[useSpeechSynthesis Debug] Filtered out browser voice post-uniqueness due to missing name/URI:`, v);
                }
              });
              console.log("[useSpeechSynthesis Debug] Mapped browser voices (name, uniqueId):", mapped.length, mapped.map(m => ({name: m.name, id: m.uniqueId})));
              return mapped;
            };

            const tryResolve = (voicesResult: SpeechSynthesisVoice[] | undefined | null) => {
              if (resolved) return;
              resolved = true;
              resolve(filterAndMapValidVoices(voicesResult));
            };
            const initialVoices = browserSpeechSynthesis.getVoices();
            if (initialVoices && initialVoices.length > 0) { tryResolve(initialVoices); return; }
            browserSpeechSynthesis.onvoiceschanged = () => { if(browserSpeechSynthesis) browserSpeechSynthesis.onvoiceschanged = null; tryResolve(browserSpeechSynthesis?.getVoices()); };
            setTimeout(() => { if(browserSpeechSynthesis) browserSpeechSynthesis.onvoiceschanged = null; tryResolve(browserSpeechSynthesis?.getVoices()); }, 2500);
          });
        };
        browserVoicesMapped = await getBrowserVoices();
      }

      try {
        const response = await fetch(`${API_BASE_URL}/google_tts_voices`);
        if (response.ok) {
          const data = await response.json();
          googleVoicesMapped = (data.voices || [])
            .filter((v: any) => v && typeof v.name === 'string' && Array.isArray(v.language_codes))
            .map((v: any) => ({ 
                ...v, type: 'google' as const, 
                supportsPitch: v.supportsPitch !== undefined ? v.supportsPitch : true, // Default to true if backend doesn't send
                uniqueId: `google_${v.name}` 
            }));
        } else { /* ... */ }
      } catch (error) { /* ... */ }

      const combined: CombinedVoice[] = [...googleVoicesMapped, ...browserVoicesMapped];
      setAllVoices(combined);

      if (combined.length > 0) {
        const defaultGoogle = combined.find(v => v.uniqueId.includes('google_en-US') && (v.uniqueId.includes('Wavenet-D') || v.uniqueId.includes('Studio-M')));
        const defaultBrowser = combined.find(v => v.type === 'browser' && (v as BrowserSpeechSynthesisVoice).default && (v as BrowserSpeechSynthesisVoice).lang.startsWith('en'));
        const firstGoogle = combined.find(v => v.type === 'google' && v.uniqueId.includes('google_en-US'));
        const firstBrowser = combined.find(v => v.type === 'browser' && (v as BrowserSpeechSynthesisVoice).lang.startsWith('en'));
        
        let defaultVoiceId: string | null = null;
        if (defaultGoogle) defaultVoiceId = defaultGoogle.uniqueId;
        else if (defaultBrowser) defaultVoiceId = (defaultBrowser as BrowserSpeechSynthesisVoice).uniqueId;
        else if (firstGoogle) defaultVoiceId = firstGoogle.uniqueId;
        else if (firstBrowser) defaultVoiceId = (firstBrowser as BrowserSpeechSynthesisVoice).uniqueId;
        else defaultVoiceId = combined[0].uniqueId;
        
        setSelectedVoiceIdentifier(defaultVoiceId);
      }
      setIsSupported(!!browserSpeechSynthesis || googleVoicesMapped.length > 0);
      setIsLoadingVoices(false);
    };
    fetchVoices();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserSpeechSynthesis]);


  _doActualSpeakRef.current = useCallback(async (text: string) => {
    const selectedVoice = allVoices.find(v => v.uniqueId === selectedVoiceIdentifier);
    if (!selectedVoice) { setIsSpeaking(false); _handleSpeechEnd(); return; }
    
    console.log(`[useSpeechSynthesis] _doActualSpeak: Starting synthesis for "${text.substring(0,30)}..." with ${selectedVoice.uniqueId}`);
    setIsSpeaking(true);
    const currentRate = rateRef.current;
    const currentPitch = pitchRef.current;

    if (selectedVoice.type === 'google') {
      if (!audioRef.current) { setIsSpeaking(false); _handleSpeechEnd(); return; }
      try {
        const payload: any = {
          text: text, languageCode: selectedVoice.language_codes[0], voiceName: selectedVoice.name,
          speakingRate: Math.max(0.25, Math.min(4.0, currentRate)),
        };
        // Use the 'supportsPitch' flag from the voice object
        if (selectedVoice.supportsPitch) { 
          payload.pitch = Math.max(-20.0, Math.min(20.0, currentPitch));
        }
        const response = await fetch(`${API_BASE_URL}/synthesize_speech_google`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({error: "Unknown TTS error"}));
          throw new Error(errData.error || `Google TTS HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.audioContent && audioRef.current) {
          audioRef.current.src = `data:audio/mp3;base64,${data.audioContent}`;
          await audioRef.current.play();
        } else { throw new Error("No audio content from Google TTS"); }
      } catch (error) { 
        if (error instanceof DOMException && error.name === 'AbortError') {
            console.warn('[useSpeechSynthesis] Google TTS play interrupted in _doActualSpeak.');
        } else { console.error('[useSpeechSynthesis] Google TTS error in _doActualSpeak:', error); }
        setIsSpeaking(false); 
        _handleSpeechEnd(); 
      }
    } else { // Browser TTS
      if (!browserSpeechSynthesis) { setIsSpeaking(false); _handleSpeechEnd(); return; }
      if (browserSpeechSynthesis.speaking) browserSpeechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utteranceRef.current = utterance;
      
      // Find the original SpeechSynthesisVoice object to pass to utterance.voice
      // This is important because the 'selectedVoice' is our mapped object.
      const browserVoiceObj = window.speechSynthesis.getVoices().find(v => v.voiceURI === (selectedVoice as BrowserSpeechSynthesisVoice).voiceURI);
      
      if (browserVoiceObj) {
          utterance.voice = browserVoiceObj;
      } else {
          // Fallback if somehow not found, though this shouldn't happen if allVoices is built correctly
          console.warn("[useSpeechSynthesis] Could not find original browser voice object for utterance. Using mapped object properties.");
          // Attempt to set lang directly as voice might not be perfect match
          utterance.lang = selectedVoice.lang;
      }

      utterance.rate = Math.max(0.1, Math.min(10, currentRate));
      utterance.pitch = Math.max(0, Math.min(2, currentPitch));
      
      utterance.onend = () => { setIsSpeaking(false); utteranceRef.current = null; _handleSpeechEnd(); };
      utterance.onerror = (e) => { console.error('Browser TTS error:', e); setIsSpeaking(false); utteranceRef.current = null; _handleSpeechEnd(); };
      browserSpeechSynthesis.speak(utterance);
    }
  }, [allVoices, selectedVoiceIdentifier, browserSpeechSynthesis, API_BASE_URL, _handleSpeechEnd]); // Removed setIsSpeaking from deps

  const speak = useCallback((text: string) => {
    if (!isSupported || !text) return;
    console.log(`[useSpeechSynthesis] speak() called. Queueing/speaking: "${text.substring(0, 30)}..."`);
    if (isSpeakingRef.current) {
      speechQueueRef.current = text;
    } else {
      _doActualSpeakRef.current(text);
    }
  }, [isSupported]);

  const cancel = useCallback(() => { 
    speechQueueRef.current = null; 
    setIsSpeaking(false);
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
    if (browserSpeechSynthesis && browserSpeechSynthesis.speaking) browserSpeechSynthesis.cancel();
    if(utteranceRef.current) { utteranceRef.current.onend = null; utteranceRef.current.onerror = null; utteranceRef.current = null; }
  }, [browserSpeechSynthesis]);

  const handleSetVoice = useCallback((uniqueId: string) => {
    setSelectedVoiceIdentifier(uniqueId);
  }, []); 

  const getSelectedVoiceInfo = useCallback((): CombinedVoice | undefined => {
    if (!selectedVoiceIdentifier) return undefined;
    return allVoices.find(v => v.uniqueId === selectedVoiceIdentifier);
  }, [allVoices, selectedVoiceIdentifier]);

  useEffect(() => {
    const currentAudio = audioRef.current;
    const currentBrowserSpeech = browserSpeechSynthesis;
    return () => {
      if (isSpeakingRef.current) { 
        if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; }
        if (currentBrowserSpeech && currentBrowserSpeech.speaking) currentBrowserSpeech.cancel();
      }
    };
  }, [browserSpeechSynthesis]);

  return {
    speak, cancel, isSpeaking, isSupported, allVoices, selectedVoiceIdentifier,
    setVoice: handleSetVoice, rate, setRate, pitch, setPitch, isLoadingVoices, getSelectedVoiceInfo,
  };
};