// src/components/LiveDetector.tsx
import React, { useState, useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { Button, Box, Text, Alert, Group, Stack, Image, Loader as MantineLoader, Card, Select, Kbd } from '@mantine/core';
import { IconCamera, IconCameraOff, IconAlertCircle, IconVolume, IconVideo } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { LiveDetectorActions } from '../App'; // Import the action interface

// TODO: Pass this from props or context
const API_BASE_URL = 'http://192.168.0.168:8080'; 
const FRAME_PROCESSING_INTERVAL = 2500;
const TTS_WAIT_CHECK_INTERVAL = 250;


export interface LiveDetectorProps { // Exporting for App.tsx if needed (though App.tsx defines its own for children)
    detectionActive: boolean;
    autoSpeakDetections: boolean;
    speak: (text: string, lang?: string) => void;
    // cancelSpeech prop removed as it's not used
    ttsIsSpeaking: boolean;
    ttsSupported: boolean;
    // isActiveTab prop removed as App.tsx handles hotkey enabling
    setHotkeyActions?: React.MutableRefObject<LiveDetectorActions>; // Corrected prop name and type
}

export const LiveDetector = React.memo(function LiveDetector({
    detectionActive, autoSpeakDetections, speak, ttsIsSpeaking, ttsSupported,
    setHotkeyActions
}: LiveDetectorProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isCameraOn, setIsCameraOn] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const instanceId = useRef(Date.now().toString(36) + Math.random().toString(36).substring(2)).current;
    
    const [isProcessingFrame, setIsProcessingFrame] = useState(false);
    const isProcessingFrameRef = useRef(isProcessingFrame);
    useEffect(() => { isProcessingFrameRef.current = isProcessingFrame; }, [isProcessingFrame]);

    const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
    const [detectionText, setDetectionText] = useState<string[]>([]);
    const [speechOutput, setSpeechOutput] = useState<string | null>(null);

    const [videoSources, setVideoSources] = useState<MediaDeviceInfo[]>([]);
    const [selectedVideoSourceId, setSelectedVideoSourceId] = useState<string>('');

    useEffect(() => {
        const getVideoSourcesAsync = async () => {
            if (!navigator.mediaDevices?.enumerateDevices) {
                console.warn("enumerateDevices() not supported.");
                setError("Camera source selection not supported by your browser.");
                return;
            }
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoInputs = devices.filter(device => device.kind === 'videoinput');
                setVideoSources(videoInputs);
                if (videoInputs.length > 0 && (!selectedVideoSourceId || !videoInputs.some(d => d.deviceId === selectedVideoSourceId))) {
                    setSelectedVideoSourceId(videoInputs[0].deviceId);
                } else if (videoInputs.length === 0) {
                    setSelectedVideoSourceId('');
                }
            } catch (err) {
                console.error("Error enumerating video devices:", err);
                setError("Could not list camera sources.");
            }
        };
        getVideoSourcesAsync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);


    const coreProcessFrameLogic = useCallback(async () => {
        if (isProcessingFrameRef.current || !videoRef.current || !canvasRef.current || !stream?.active || !detectionActive || !isCameraOn) {
            if(isProcessingFrameRef.current) console.warn(`[LiveDetector ${instanceId}] coreProcessFrameLogic called while already processing. Refusing.`);
            return;
        }
        setIsProcessingFrame(true);

        const video = videoRef.current; 
        const canvas = canvasRef.current;

        try {
            canvas.width = video.videoWidth > 0 ? video.videoWidth : 640;
            canvas.height = video.videoHeight > 0 ? video.videoHeight : 480;
            if (video.videoWidth === 0 || video.videoHeight === 0) {
                console.warn(`[LiveDetector ${instanceId}] Video dimensions 0. Using fallback ${canvas.width}x${canvas.height}.`);
            }
            const context = canvas.getContext('2d');
            if (!context) {
                throw new Error("Canvas context error");
            }
            context.drawImage(video, 0, 0, canvas.width, canvas.height);

            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            if (!blob) throw new Error("Canvas to blob conversion failed.");

            const formData = new FormData();
            formData.append('image', blob, 'liveframe.jpg');

            const imageResponse = await fetch(`${API_BASE_URL}/process_image?draw_boxes=true`, { method: 'POST', body: formData });
            if (!imageResponse.ok) { 
                const errData = await imageResponse.json().catch(() => ({ message: `Frame processing (image) failed: ${imageResponse.statusText}` })); 
                throw new Error(errData.message); 
            }
            const imageBlobResult = await imageResponse.blob();
            setProcessedImageUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return URL.createObjectURL(imageBlobResult); });

            const dataResponse = await fetch(`${API_BASE_URL}/process_image`, { method: 'POST', body: formData });
            if (!dataResponse.ok) { 
                const errData = await dataResponse.json().catch(() => ({ message: `Frame processing (data) failed: ${dataResponse.statusText}` })); 
                throw new Error(errData.message); 
            }
            const data = await dataResponse.json();

            setDetectionText(data.detections_text || []);
            const newSpeech = data.speech_output || null;
            if (newSpeech !== speechOutput) setSpeechOutput(newSpeech);

            if (newSpeech && ttsSupported && autoSpeakDetections) {
                speak(newSpeech); 
            }
        } catch (err: any) {
            console.error(`[LiveDetector ${instanceId}] Error in coreProcessFrameLogic:`, err);
            notifications.show({ title: 'Live Processing Error', message: err.message || "An unknown error occurred.", color: 'red', autoClose: 5000 });
        } finally {
            setIsProcessingFrame(false);
        }
    }, [
        detectionActive, isCameraOn, stream, autoSpeakDetections, speechOutput,
        speak, ttsSupported,
        setIsProcessingFrame, // Explicitly add setIsProcessingFrame if it's used directly
        instanceId // Removed setError, setProcessedImageUrl, setDetectionText, setSpeechOutput as they are setters from useState
                   // If these setters are derived from props or complex logic, they might be needed.
                   // For simple useState setters, they are stable.
    ]);
    const processFrameFnRef = useRef(coreProcessFrameLogic);
    useEffect(() => { processFrameFnRef.current = coreProcessFrameLogic; }, [coreProcessFrameLogic]);


    useEffect(() => {
        let loopTimeoutId: NodeJS.Timeout | null = null;
        let isActiveComponent = true;

        const scheduleNextLoop = (delay: number) => {
            if (loopTimeoutId) clearTimeout(loopTimeoutId);
            if (isActiveComponent) {
                loopTimeoutId = setTimeout(mainLoop, delay);
            }
        };

        const mainLoop = async () => {
            if (!isActiveComponent) return;

            if (!isCameraOn || !stream?.active || !detectionActive || isProcessingFrameRef.current) {
                scheduleNextLoop(FRAME_PROCESSING_INTERVAL);
                return;
            }

            if (ttsIsSpeaking) {
                scheduleNextLoop(TTS_WAIT_CHECK_INTERVAL);
                return;
            }
            
            try {
                await processFrameFnRef.current();
            } catch (e) {
                console.error(`[LiveDetector ${instanceId}] Error from processFrameFnRef in loop:`, e);
            } finally {
                if (isActiveComponent) {
                    scheduleNextLoop(FRAME_PROCESSING_INTERVAL);
                }
            }
        };

        if (isCameraOn && detectionActive) {
            scheduleNextLoop(FRAME_PROCESSING_INTERVAL);
        } else {
            if (loopTimeoutId) clearTimeout(loopTimeoutId);
        }

        return () => {
            isActiveComponent = false;
            if (loopTimeoutId) clearTimeout(loopTimeoutId);
        };
    }, [isCameraOn, stream, detectionActive, ttsIsSpeaking]);

    const stopCamera = useCallback((switchingSource = false) => {
        setIsProcessingFrame(false); 
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        if (videoRef.current) videoRef.current.srcObject = null;
        setStream(null);
        if (!switchingSource) {
            setIsCameraOn(false);
            setProcessedImageUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return null; });
            setDetectionText([]);
            setSpeechOutput(null);
        }
    }, [stream, setIsProcessingFrame]);
    const stopCameraFnRef = useRef(stopCamera);
    useEffect(() => { stopCameraFnRef.current = stopCamera; }, [stopCamera]);

    const startCamera = useCallback(async (deviceIdToStart?: string) => {
        setError(null);
        if (!detectionActive) { setError("Detection is paused. Enable it from the sidebar."); return; }
        const targetDeviceId = deviceIdToStart || selectedVideoSourceId;
        if (!targetDeviceId && videoSources.length > 0) { setError("Please select a camera source."); return; }
        if (videoSources.length === 0 && !targetDeviceId) { setError("No camera sources found."); return; }

        if (isCameraOn && stream) {
            const currentTrackSettings = stream.getVideoTracks()[0]?.getSettings();
            if (currentTrackSettings?.deviceId !== targetDeviceId) {
                stopCameraFnRef.current(true); 
                await new Promise(resolve => setTimeout(resolve, 100)); 
            } else { return; }
        } else if (isCameraOn) { 
            stopCameraFnRef.current(true); await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        setIsProcessingFrame(false);
        const constraints: MediaStreamConstraints = { video: targetDeviceId ? { deviceId: { exact: targetDeviceId } } : true, audio: false };
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            if (videoRef.current) { videoRef.current.srcObject = mediaStream; await videoRef.current.play(); }
            setStream(mediaStream);
            setIsCameraOn(true);
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoInputs = devices.filter(device => device.kind === 'videoinput');
            setVideoSources(videoInputs);
            if (targetDeviceId && videoInputs.some(d => d.deviceId === targetDeviceId)) {
                 setSelectedVideoSourceId(targetDeviceId);
            } else if (videoInputs.length > 0) {
                 setSelectedVideoSourceId(videoInputs[0].deviceId);
            }
        } catch (err: any) {
            console.error(`[LiveDetector ${instanceId}] Error starting camera:`, err);
            setError(`Could not start camera: ${err.name} - ${err.message}.`);
            setIsCameraOn(false);
            if (stream) stream.getTracks().forEach(track => track.stop());
            setStream(null);
        }
    }, [detectionActive, selectedVideoSourceId, videoSources, isCameraOn, stream, instanceId, stopCameraFnRef, setIsProcessingFrame]);

    useEffect(() => {
        if (isCameraOn && selectedVideoSourceId && stream) {
            const currentTrackDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
            if (currentTrackDeviceId && currentTrackDeviceId !== selectedVideoSourceId) {
                startCamera(selectedVideoSourceId);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedVideoSourceId, startCamera]); // Added startCamera dependency

    useEffect(() => { if (!detectionActive && isCameraOn) stopCameraFnRef.current(false); }, [detectionActive, isCameraOn, stopCameraFnRef]);

    useEffect(() => {
        const currentStop = stopCameraFnRef.current;
        return () => { currentStop(false); 
            setProcessedImageUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return null; });
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleToggleCamera = useCallback(() => {
        if (isCameraOn) {
            stopCameraFnRef.current(false);
        } else {
            if (detectionActive) startCamera();
            else setError("Detection must be active to start the camera.");
        }
    }, [isCameraOn, detectionActive, startCamera, stopCameraFnRef]);

    useEffect(() => {
        if (setHotkeyActions?.current) { // Check if the ref itself is provided
            setHotkeyActions.current.startStop = handleToggleCamera;
        }
        return () => {
            if (setHotkeyActions?.current) {
                setHotkeyActions.current.startStop = undefined; // Clear on unmount
            }
        }
    }, [setHotkeyActions, handleToggleCamera]);
    
    const videoSourceOptions = videoSources.map(source => ({
        value: source.deviceId,
        label: source.label || `Camera ${source.deviceId.substring(0, 8)}...`
    }));
    
    // Reinstated cantStartCamera logic for button disabled state
    const cantStartCamera = !detectionActive || (videoSources.length > 0 && !selectedVideoSourceId && !isCameraOn) || (videoSources.length === 0 && !isCameraOn) ;


    return (
        <Stack gap="lg" align='center' justify='center'>
            <Group>
                <Select
                    placeholder={videoSources.length > 0 ? "Select camera" : "No cameras found"}
                    data={videoSourceOptions}
                    value={selectedVideoSourceId}
                    onChange={(value) => setSelectedVideoSourceId(value || '')}
                    disabled={videoSources.length === 0 || isCameraOn || !detectionActive}
                    leftSection={<IconVideo size={16} />}
                    comboboxProps={{ shadow: 'md', transitionProps: { transition: 'pop', duration: 200 } }}
                    style={{ minWidth: 250 }}
                    nothingFoundMessage="No camera sources found"
                />
                <Button 
                    leftSection={isCameraOn ? <IconCameraOff size={16} /> : <IconCamera size={16} />} 
                    onClick={handleToggleCamera} 
                    disabled={cantStartCamera && !isCameraOn} // Can always stop; disable start if conditions not met
                    color={isCameraOn ? "red" : "blue"}
                >
                    {isCameraOn ? <>Start Camera <Kbd ml="xs">S</Kbd></> : <>Stop Camera <Kbd ml="xs">S</Kbd></>}
                </Button>
            </Group>

            {!detectionActive && !isCameraOn && (
                <Alert icon={<IconAlertCircle size="1rem" />} title="Detection Paused" color="orange" radius="md">
                    Global object detection is paused. Enable it from the sidebar to start the camera.
                </Alert>
            )}
            {error && (
                <Alert icon={<IconAlertCircle size="1rem" />} title="Camera Error" color="red" radius="md" withCloseButton onClose={() => setError(null)}>{error}</Alert>
            )}

            <video ref={videoRef} autoPlay playsInline muted style={{ display: 'none' }} />
            <canvas ref={canvasRef} style={{ display: 'none' }} />

            <Box style={{ width: '100%' }}>
                <Text size="sm" ta="center" mb="xs" fw={500}>
                    Processed Feed {isProcessingFrameRef.current && <MantineLoader size="xs" type="dots" display="inline-block" ml="xs" />}
                    {isCameraOn && ttsIsSpeaking && <Text size="xs" c="blue" display="inline-block" ml="xs">(Speaking...)</Text>}
                </Text>
                <Box
                    pos="relative"
                    style={{
                        width: '100%', maxWidth: '800px', margin: '0 auto', aspectRatio: '16/9',
                        backgroundColor: 'var(--mantine-color-dark-6)', // Mantine CSS variables should work
                        border: '1px solid var(--mantine-color-gray-3)',
                        borderRadius: 'var(--mantine-radius-md)',
                        overflow: 'hidden'
                    }}
                >
                    {processedImageUrl ? (
                        <Image src={processedImageUrl} alt="Processed live frame" radius="md" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    ) : (
                        <Group style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Stack align="center" gap="xs">
                                {isCameraOn && detectionActive && !isProcessingFrameRef.current && <MantineLoader type="oval" />}
                                <Text c="dimmed" size="sm">
                                    {videoSources.length === 0 && !isCameraOn ? "No camera sources found." :
                                        !selectedVideoSourceId && videoSources.length > 0 && !isCameraOn ? "Please select a camera source." :
                                            isCameraOn && detectionActive ? (isProcessingFrameRef.current ? 'Processing...' : (ttsIsSpeaking ? 'Waiting for speech...' : 'Awaiting first processed frame...')) :
                                                (isCameraOn && !detectionActive) ? 'Detection paused globally.' :
                                                    'Select a camera and start to see processed feed.'}
                                </Text>
                            </Stack>
                        </Group>
                    )}
                </Box>
            </Box>

            {detectionText.length > 0 && (
                <Box mt="xl" w="100%" style={{ maxWidth: '800px'}}>
                    <Text size="lg" fw={700} ta="center" mb="md">Detected Objects</Text>
                    <Group justify="center" gap="sm">
                        {detectionText.map((text, index) => (
                            <Card key={index} shadow="sm" padding="lg" radius="md" withBorder>
                                <Text size="sm" ta="center" dangerouslySetInnerHTML={{ __html: text.replace(/\[(.*?)\]/g, '<span style="color: gray; font-size: 0.9em;">[$1]</span>') }} />
                            </Card>
                        ))}
                    </Group>
                </Box>
            )}

            {speechOutput && ttsSupported && !ttsIsSpeaking && (
                <Button onClick={() => speak(speechOutput)} variant="light" size="md" mt="md" leftSection={<IconVolume size={14} />} >
                    Replay: "{speechOutput.length > 40 ? speechOutput.substring(0, 37) + "..." : speechOutput}"
                </Button>
            )}
        </Stack>
    );
});