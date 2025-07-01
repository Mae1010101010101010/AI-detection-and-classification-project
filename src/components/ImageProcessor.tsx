// src/components/ImageProcessor.tsx
import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import { 
    FileInput, Button, Image, Group, Stack, Text, Loader, Alert, Box, ActionIcon, Tooltip,
    Paper, Kbd, ScrollArea, useMantineTheme // Added missing Mantine imports
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconUpload, IconAlertCircle, IconVolume, IconPlayerStop, IconInfoCircle, IconX
} from '@tabler/icons-react';
import type { ImageProcessorActions } from '../App'; // Corrected import based on App.tsx export

// TODO: This should ideally come from props or context
const API_BASE_URL = 'http://192.168.0.168:8080'; 

export interface ImageProcessorProps { // Exporting this interface
  detectionActive: boolean;
  autoSpeakDetections: boolean;
  speak: (text: string, lang?: string) => void;
  cancelSpeech: () => void;
  ttsIsSpeaking: boolean;
  ttsSupported: boolean;
  setHotkeyActions?: React.MutableRefObject<ImageProcessorActions>; // Corrected type
}

export function ImageProcessor({
  detectionActive,
  autoSpeakDetections,
  speak,
  cancelSpeech,
  ttsIsSpeaking,
  ttsSupported,
  setHotkeyActions
}: ImageProcessorProps) {
  const theme = useMantineTheme(); // Added theme hook call
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [detectionData, setDetectionData] = useState<{ text: string[], json: any[], speech: string | null }>({
    text: [],
    json: [],
    speech: null,
  });

  const fileInputRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedFile]);

  useEffect(() => {
    if (detectionData.speech && ttsSupported && detectionActive && autoSpeakDetections) {
      if (!ttsIsSpeaking) {
        speak(detectionData.speech);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectionData.speech, detectionActive, autoSpeakDetections, speak]);


  const handleFileChange = (file: File | null) => {
    setSelectedFile(file);
    setProcessedImageUrl(null); 
    setValidationError(null);
    setDetectionData({ text: [], json: [], speech: null }); 
    if (ttsIsSpeaking) {
        cancelSpeech();
    }
  };

  const handleSubmit = useCallback(async () => {
    if (!selectedFile) {
      setValidationError('Please select an image file first.');
      if (fileInputRef.current) fileInputRef.current.focus();
      return;
    }
    if (!detectionActive) {
        setValidationError('Detection is currently paused. Please resume detection to process images.');
        if(ttsSupported && autoSpeakDetections) speak('Detection is currently paused.');
        return;
    }

    setIsLoading(true);
    setValidationError(null);
    // Revoke previous processed image URL if it exists, before setting to null
    if (processedImageUrl) {
        URL.revokeObjectURL(processedImageUrl);
    }
    setProcessedImageUrl(null);
    setDetectionData({ text: [], json: [], speech: null });
    if (ttsIsSpeaking) cancelSpeech();

    const formData = new FormData();
    formData.append('image', selectedFile);

    try {
      const imageResponse = await fetch(`${API_BASE_URL}/process_image?draw_boxes=true`, { method: 'POST', body: formData });
      if (!imageResponse.ok) {
        const errorData = await imageResponse.json().catch(() => ({ error: `Image processing failed (status ${imageResponse.status})` }));
        if (imageResponse.status === 423 && errorData.speech_output && ttsSupported && autoSpeakDetections) speak(errorData.speech_output);
        throw new Error(errorData.message || errorData.error || `Image processing failed`);
      }
      const imageBlob = await imageResponse.blob();
      if (imageBlob.type.startsWith('image/')) {
        // No need to revoke here again as it's handled at the start of the function if (processedImageUrl)
        setProcessedImageUrl(URL.createObjectURL(imageBlob));
      } else {
        const textError = await imageBlob.text();
        console.error("Received non-image blob:", textError);
        throw new Error(`Received unexpected content type from server: ${imageBlob.type}.`);
      }

      const formDataForData = new FormData(); // Re-create formData as it might be consumed
      formDataForData.append('image', selectedFile);

      const dataResponse = await fetch(`${API_BASE_URL}/process_image`, { method: 'POST', body: formDataForData });
      if (!dataResponse.ok) {
        const errorData = await dataResponse.json().catch(() => ({ error: `Workspaceing detection data failed (status ${dataResponse.status})` }));
        if (dataResponse.status === 423 && errorData.speech_output && ttsSupported && autoSpeakDetections) speak(errorData.speech_output);
        throw new Error(errorData.message || errorData.error || `Workspaceing detection data failed`);
      }
      const data = await dataResponse.json();
      setDetectionData({
        text: data.detections_text || [],
        json: data.detections_json || [],
        speech: data.speech_output || null,
      });
    } catch (err: any) {
      console.error('Processing error:', err);
      notifications.show({
        title: 'Image Processing Error',
        message: err.message || 'An unexpected error occurred during image processing.',
        color: 'red',
        icon: <IconX size={18} />,
        autoClose: 7000,
      });
      setProcessedImageUrl(prev => { 
          if (prev) URL.revokeObjectURL(prev); // Ensure revoke on error too
          return null;
      });
    } finally {
      setIsLoading(false);
    }
  }, [selectedFile, detectionActive, ttsSupported, autoSpeakDetections, speak, cancelSpeech, ttsIsSpeaking, processedImageUrl]);

  const handleSpeakButtonClick = useCallback(() => {
    if (detectionData.speech && ttsSupported) {
      if (ttsIsSpeaking) {
        cancelSpeech();
      } else {
        speak(detectionData.speech);
      }
    }
  }, [detectionData.speech, ttsSupported, ttsIsSpeaking, speak, cancelSpeech]);

  useEffect(() => {
    if (setHotkeyActions?.current) {
      setHotkeyActions.current.submit = () => {
        if (selectedFile && !isLoading && detectionActive) {
          handleSubmit();
        } else if (!selectedFile) {
          setValidationError('Please select an image file first.');
          if (fileInputRef.current) fileInputRef.current.focus();
        } else if (!detectionActive) {
          setValidationError('Detection is currently paused.');
        }
      };
      setHotkeyActions.current.speak = () => {
        if (detectionData.speech && ttsSupported) {
          handleSpeakButtonClick();
        }
      };
    }
    return () => {
      if (setHotkeyActions?.current) {
        setHotkeyActions.current.submit = undefined;
        setHotkeyActions.current.speak = undefined;
      }
    };
  }, [setHotkeyActions, handleSubmit, handleSpeakButtonClick, selectedFile, isLoading, detectionActive, detectionData, ttsSupported]);

  useEffect(() => {
    let currentProcessedUrl = processedImageUrl; // Capture current value for cleanup
    return () => {
      if (currentProcessedUrl) {
        URL.revokeObjectURL(currentProcessedUrl);
      }
    };
  }, [processedImageUrl]);


  return (
    <Stack gap="lg">
      {!detectionActive && (
        <Alert icon={<IconInfoCircle size="1rem" />} title="Detection Paused" color="orange" radius="md" mb="md">
          Image processing is currently paused. Enable detection from the sidebar to proceed.
        </Alert>
      )}
       {validationError && (
        <Alert icon={<IconAlertCircle size="1rem" />} title="Input Required" color="yellow" radius="md" withCloseButton onClose={() => setValidationError(null)} mb="md">
          {validationError}
        </Alert>
      )}
      <FileInput
        ref={fileInputRef}
        disabled={isLoading || !detectionActive}
        onChange={handleFileChange}
        label="Upload Image"
        placeholder="Click to select an image"
        accept="image/png,image/jpeg,image/webp"
        value={selectedFile}
        leftSection={<IconUpload size={18} />}
        clearable
        aria-describedby={ttsSupported ? undefined : "tts-not-supported-image"}
      />
      {!ttsSupported && <Text id="tts-not-supported-image" c="dimmed" size="xs">Text-to-speech is not supported by your browser.</Text>}

      {previewUrl && !processedImageUrl && (
         <Box>
            <Text size="sm" fw={500} mb="xs">Original Image Preview:</Text>
            <Paper shadow="sm" radius="md" withBorder p="xs" style={{maxWidth: 400, margin: 'auto'}}>
                <Image src={previewUrl} alt="Selected image preview" maw={400} mah={400} fit="contain" radius="sm" />
            </Paper>
        </Box>
      )}

      <Button onClick={handleSubmit} disabled={!selectedFile || isLoading || !detectionActive} loading={isLoading} fullWidth>
        Process Image <Kbd ml="xs" style={{display: 'inline-block', verticalAlign: 'middle'}}>ENTER</Kbd>
      </Button>

      {isLoading && <Group justify="center"><Loader /></Group>}

       {processedImageUrl && (
         <Box>
            <Text size="sm" fw={500} mb="xs">Processed Image (with Detections):</Text>
            <Paper shadow="md" radius="md" withBorder p="xs" style={{maxWidth: 600, margin: 'auto'}}>
                <Image src={processedImageUrl} alt="Processed image with detections" maw={600} mah={600} fit="contain" radius="sm" />
            </Paper>
        </Box>
      )}

      {detectionData.text.length > 0 && (
        <Box mt="md" p="md" style={{border: `1px solid ${theme.colors.gray[6]}`, borderRadius: theme.radius.md}}>
          <Text size="sm" fw={500} mb="xs">Detection Summary:</Text>
          <ScrollArea.Autosize mah={200}>
            {detectionData.text.map((detection, index) => (
              <Text key={index} size="sm" dangerouslySetInnerHTML={{ __html: detection.replace(/\[(.*?)\]/g, '<span style="color: gray; font-size: 0.9em;">[$1]</span>') }} />
            ))}
          </ScrollArea.Autosize>
        </Box>
      )}

      {detectionData.speech && ttsSupported && (
        <Box mt="md">
          <Group justify="space-between" align="center">
            <Text size="sm" fw={500}>Generated Speech Text:</Text>
            <Tooltip label={ttsIsSpeaking ? "Stop Speech (S)" : "Speak Text (S)"}>
              <ActionIcon variant="outline" onClick={handleSpeakButtonClick} size="lg" aria-label={ttsIsSpeaking ? "Stop speech" : "Speak detection summary"}>
                {ttsIsSpeaking ? <IconPlayerStop size={20} /> : <IconVolume size={20} />}
              </ActionIcon>
            </Tooltip>
          </Group>
          <Text size="sm" c="dimmed" fs="italic" mt={4}>"{detectionData.speech}"</Text>
        </Box>
      )}
    </Stack>
  );
}