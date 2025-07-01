// src/App.tsx
import { useEffect, useState, useMemo, useRef } from 'react';
import {
  AppShell, Alert, Loader, Burger, Group, Title, ActionIcon, useMantineColorScheme,
  Text, Switch, Box, Button, Stack, Divider, NavLink, ScrollArea, Paper, Badge,
  useMantineTheme, Select, Slider, Modal, Kbd, Table
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { useHotkeys } from 'react-hotkeys-hook';
import {
  IconSun, IconMoon, IconPlayerPlay, IconPlayerPause, IconVolume,
  IconPhoto, IconCamera as IconLiveCameraTab, IconAlertCircle, IconKeyboard
} from '@tabler/icons-react';
// Ensure ImageProcessorProps is exported from ImageProcessor.tsx
import { ImageProcessor, type ImageProcessorProps as ChildImageProcessorProps } from './components/ImageProcessor';
import { LiveDetector, type LiveDetectorProps as ChildLiveDetectorProps } from './components/LiveDetector'; // Assuming LiveDetectorProps is exported
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis';
import type { GoogleCloudVoice, BrowserSpeechSynthesisVoice } from './hooks/useSpeechSynthesis';
import { notifications } from '@mantine/notifications';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080';

interface AppStatus { detection_active: boolean; model_loaded: boolean; model_input_name?: string; model_input_shape?: number[]; class_names_count?: number; }
interface ComboboxOption { value: string; label: string; disabled?: boolean; }
interface ComboboxItemGroup { group: string; items: ComboboxOption[]; }
type ExplicitlyGroupedComboboxData = ComboboxItemGroup[];

interface ShortcutInfo {
  keys: string | string[];
  description: string;
  scope?: string;
}

// Define Action interfaces for child components (to be exported)
export interface ImageProcessorActions {
  submit?: () => void;
  speak?: () => void;
}
export interface LiveDetectorActions {
  startStop?: () => void;
}

const APP_SHORTCUTS: ShortcutInfo[] = [
  { keys: '?', description: 'Show this shortcuts guide', scope: 'Global' },
  { keys: 'N', description: 'Toggle Navigation Panel', scope: 'Global' },
  { keys: 'T', description: 'Toggle Dark/Light Theme', scope: 'Global' },
  { keys: 'P', description: 'Toggle Object Detection (Play/Pause)', scope: 'Global' },
  { keys: 'R', description: 'Repeat Last Announcement', scope: 'Global' },
  { keys: 'L', description: 'Switch to Live Camera Tab', scope: 'Global' },
  { keys: 'U', description: 'Switch to Image File Tab (Upload)', scope: 'Global' },
  { keys: 'A', description: 'Toggle Auto Announce Detections', scope: 'Speech' },
  { keys: 'C', description: 'Toggle Announce Scene Clear', scope: 'Speech' },
  { keys: 'S', description: 'Start/Stop Camera (Live Tab) / Speak Detections (Image Tab)', scope: 'Contextual' },
  { keys: 'Enter', description: 'Process Image (Image Tab, if file selected)', scope: 'Image Processor' },
];


function App() {
  const [navbarOpened, { toggle: toggleNavbar, close: closeNavbar }] = useDisclosure(true);
  const { colorScheme, setColorScheme } = useMantineColorScheme({ keepTransitions: true });
  const theme = useMantineTheme();
  const isMobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm})`);

  const {
    speak, cancel: cancelSpeech, isSpeaking: ttsIsSpeaking, isSupported: ttsSupported,
    allVoices, selectedVoiceIdentifier, setVoice,
    rate, setRate, pitch, setPitch, isLoadingVoices, getSelectedVoiceInfo
  } = useSpeechSynthesis();
  
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isTogglingDetection, setIsTogglingDetection] = useState(false);
  const [isRepeatingAnnouncement, setIsRepeatingAnnouncement] = useState(false);
  const [announceSceneClear, setAnnounceSceneClear] = useState<boolean | null>(null);
  const [isLoadingAnnounceSetting, setIsLoadingAnnounceSetting] = useState(true);
  const [isUpdatingAnnounceSetting, setIsUpdatingAnnounceSetting] = useState(false);
  const [autoSpeakDetections, setAutoSpeakDetections] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('live-camera');

  const [shortcutsModalOpened, { open: openShortcutsModal, close: closeShortcutsModal }] = useDisclosure(false);

  const imageProcessorActions = useRef<ImageProcessorActions>({});
  const liveDetectorActions = useRef<LiveDetectorActions>({});


  useEffect(() => {
    const fetchInitialData = async () => {
      setIsLoadingStatus(true); setIsLoadingAnnounceSetting(true);
      try {
        const statusResponse = await fetch(`${API_BASE_URL}/status`);
        if (!statusResponse.ok) throw new Error(`Status: ${statusResponse.statusText}`);
        setAppStatus(await statusResponse.json());
        const announceSettingResponse = await fetch(`${API_BASE_URL}/settings/announce_scene_clear`);
        if (!announceSettingResponse.ok) throw new Error(`Announce: ${announceSettingResponse.statusText}`);
        setAnnounceSceneClear((await announceSettingResponse.json()).value);
      } catch (error) { 
        console.error("Error fetching initial data:", error);
        notifications.show({
            title: 'Initialization Error',
            message: `Could not fetch initial app data: ${error instanceof Error ? error.message : String(error)}`,
            color: 'red',
            icon: <IconAlertCircle />
        });
        if (appStatus === null) setAppStatus({ detection_active: true, model_loaded: false });
        if (announceSceneClear === null) setAnnounceSceneClear(true);
      } finally { setIsLoadingStatus(false); setIsLoadingAnnounceSetting(false); }
    };
    fetchInitialData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleDetection = async () => { 
    if (!appStatus || isTogglingDetection) return; setIsTogglingDetection(true);
    try {
      const response = await fetch(`${API_BASE_URL}/toggle_detection`, { method: 'POST' });
      if (!response.ok) throw new Error(response.statusText);
      const data = await response.json();
      setAppStatus(prev => ({ ...prev!, detection_active: data.detection_active }));
      if (data.speech_output && ttsSupported && autoSpeakDetections) speak(data.speech_output);
    } catch (e) { 
        console.error("Err toggle detection:", e); 
        notifications.show({ title: 'Error', message: 'Failed to toggle detection status.', color: 'red', icon: <IconAlertCircle /> });
    } 
    finally { setIsTogglingDetection(false); }
  };

  const handleRepeatAnnouncement = async () => { 
    if (isRepeatingAnnouncement || ttsIsSpeaking) return;
    setIsRepeatingAnnouncement(true);
    try {
      const response = await fetch(`${API_BASE_URL}/repeat_last_announcement_text`);
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 404 && data.message && ttsSupported) speak(data.message);
        else throw new Error(data.message || response.statusText); return;
      }
      if (data.speech_output && ttsSupported) speak(data.speech_output);
      else if (ttsSupported) speak("Nothing to repeat.");
    } catch (e) { 
        console.error("Err repeat announce:", e); 
        if (ttsSupported) speak("Could not repeat announcement.");
        notifications.show({ title: 'Error', message: 'Failed to repeat last announcement.', color: 'red', icon: <IconAlertCircle /> });
    }
    finally { setIsRepeatingAnnouncement(false); }
  };

  const handleToggleAnnounceSceneClear = async () => { 
    if (announceSceneClear === null || isUpdatingAnnounceSetting) return; 
    const newValue = !announceSceneClear; 
    setIsUpdatingAnnounceSetting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/settings/announce_scene_clear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: newValue }), });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      setAnnounceSceneClear(data.value);
      if (data.message && ttsSupported) speak(data.message);
    } catch (e) { 
        console.error("Err toggle announce clear:", e); 
        if (ttsSupported) speak("Failed to update setting.");
        notifications.show({ title: 'Error', message: "Failed to update 'Announce Scene Clear' setting.", color: 'red', icon: <IconAlertCircle /> });
        const res = await fetch(`${API_BASE_URL}/settings/announce_scene_clear`); if(res.ok) setAnnounceSceneClear((await res.json()).value);
    } finally { setIsUpdatingAnnounceSetting(false); }
  };
  
  const groupedVoiceOptions: ExplicitlyGroupedComboboxData = useMemo(() => {
    if (isLoadingVoices || !allVoices || allVoices.length === 0) return [];
    const googleOpts: ComboboxOption[] = allVoices
      .filter((v): v is GoogleCloudVoice => v.type === 'google')
      .map(v => ({ 
        value: v.uniqueId, 
        label: `(G) ${v.name.replace(/-/g, ' ').replace('Standard', 'Std.').replace('Wavenet', 'WN').replace('Studio', 'Stu.')} (${v.language_codes[0]})`
      }));
    const browserOpts: ComboboxOption[] = allVoices
      .filter((v): v is BrowserSpeechSynthesisVoice => v.type === 'browser')
      .map(v => ({ 
        value: v.uniqueId, 
        label: `(B) ${v.name} (${v.lang || 'N/A'})`
      }));
    const result: ExplicitlyGroupedComboboxData = [];
    if (googleOpts.length > 0) result.push({ group: 'Google Cloud Voices', items: googleOpts.sort((a,b) => a.label.localeCompare(b.label)) });
    if (browserOpts.length > 0) result.push({ group: 'Browser Voices', items: browserOpts.sort((a,b) => a.label.localeCompare(b.label)) });
    return result;
  }, [allVoices, isLoadingVoices]);

  const navLinks = [
    { icon: <IconLiveCameraTab size="1rem" />, label: <>Live Camera <Kbd ml="xs">L</Kbd></>, value: 'live-camera' },
    { icon: <IconPhoto size="1rem" />, label: <>Image Upload <Kbd ml="xs">U</Kbd></>, value: 'file-upload' },
  ];

  const selectedVoiceInfo = getSelectedVoiceInfo();
  const isGoogleVoiceSelected = selectedVoiceInfo?.type === 'google';
  const currentGoogleVoiceSupportsPitch = isGoogleVoiceSelected && (selectedVoiceInfo as GoogleCloudVoice).supportsPitch !== false;

  useHotkeys('h', (e) => { e.preventDefault(); openShortcutsModal(); }, { preventDefault: true });
  useHotkeys('n', (e) => { e.preventDefault(); toggleNavbar(); });
  useHotkeys('t', (e) => { e.preventDefault(); setColorScheme(colorScheme === 'light' ? 'dark' : 'light'); });
  useHotkeys('p', (e) => { e.preventDefault(); if (appStatus && !isLoadingStatus) handleToggleDetection(); }, [appStatus, isLoadingStatus, handleToggleDetection]);
  useHotkeys('r', (e) => { e.preventDefault(); handleRepeatAnnouncement(); }, [handleRepeatAnnouncement]);
  
  useHotkeys('l', (e) => { e.preventDefault(); setActiveTab('live-camera'); if (isMobile) closeNavbar(); }, [isMobile, closeNavbar, setActiveTab]);
  useHotkeys('u', (e) => { e.preventDefault(); setActiveTab('file-upload'); if (isMobile) closeNavbar(); }, [isMobile, closeNavbar, setActiveTab]);

  useHotkeys('a', (e) => { e.preventDefault(); if (ttsSupported) setAutoSpeakDetections(prev => !prev); }, { enabled: ttsSupported }, [ttsSupported, setAutoSpeakDetections]);
  useHotkeys('c', (e) => { e.preventDefault(); if (announceSceneClear !== null && !isLoadingAnnounceSetting) handleToggleAnnounceSceneClear(); }, { enabled: announceSceneClear !== null && !isLoadingAnnounceSetting }, [announceSceneClear, isLoadingAnnounceSetting, handleToggleAnnounceSceneClear]);

  useHotkeys('s', (e) => {
    e.preventDefault();
    if (activeTab === 'live-camera' && liveDetectorActions.current.startStop) {
      liveDetectorActions.current.startStop();
    } else if (activeTab === 'file-upload' && imageProcessorActions.current.speak) {
      imageProcessorActions.current.speak();
    }
  }, { enabled: activeTab === 'live-camera' || activeTab === 'file-upload' }, [activeTab, liveDetectorActions, imageProcessorActions]);

  useHotkeys('enter', (e) => {
    if (activeTab === 'file-upload' && imageProcessorActions.current.submit) {
      e.preventDefault();
      imageProcessorActions.current.submit();
    }
  }, { enabled: activeTab === 'file-upload' }, [activeTab, imageProcessorActions]);


  return (
    <AppShell 
        padding="md" 
        navbar={{ width: 300, breakpoint: 'sm', collapsed: { mobile: !navbarOpened, desktop: false } }}
        header={{ height: isMobile ? 60 : 0 }}
    >
      {isMobile && (
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
              <Group>
                  <Burger opened={navbarOpened} onClick={toggleNavbar} hiddenFrom="sm" size="sm" />
                  <Title order={3}>ThirdEye</Title>
              </Group>
              <ActionIcon onClick={() => setColorScheme(colorScheme === 'light' ? 'dark' : 'light')} variant="default" size="lg" aria-label={`Switch to ${colorScheme === 'light' ? 'dark' : 'light'} mode`}>
                  {colorScheme === 'light' ? <IconMoon /> : <IconSun />}
              </ActionIcon>
          </Group>
        </AppShell.Header>
      )}

      <AppShell.Navbar p="md">
        <ScrollArea style={{ height: 'calc(100% - 130px)' /* Approx height for footer elements */ }}>
          <Stack justify="space-between" style={{ height: '100%' }}>
            <Box>
              {!isMobile && (
                <Group justify="space-between" align="center" mb="md">
                    <Title order={3}>ThirdEye</Title>
                    <ActionIcon onClick={() => setColorScheme(colorScheme === 'light' ? 'dark' : 'light')} variant="default" size="lg" aria-label={`Switch to ${colorScheme === 'light' ? 'dark' : 'light'} mode`}>
                        {colorScheme === 'light' ? <IconMoon /> : <IconSun />}
                    </ActionIcon>
                </Group>
              )}
              {/* {isMobile && <Burger opened={navbarOpened} onClick={toggleNavbar} mb="md" aria-label="Toggle navigation" />} */}

              {!isMobile && <Divider my="md"/>}
              <Paper shadow="none" p="sm" withBorder style={{borderColor: appStatus?.detection_active ? theme.colors.green[6] : theme.colors.red[6], borderWidth: '1px', borderStyle: 'solid'}}>
                <Group justify="space-between" align="center" wrap="nowrap">
                  <Stack gap={0}>
                    <Text fw={500} size="sm">Object Detection <Kbd ml="xs">P</Kbd></Text>
                    {isLoadingStatus && <Text size="xs">Loading status...</Text>}
                    {!isLoadingStatus && !appStatus && <Text size="xs" c="red">Status unavailable.</Text>}
                  </Stack>
                  {appStatus && !isLoadingStatus && (
                    <Switch color={appStatus.detection_active ? theme.colors.green[6] : theme.colors.red[6]} labelPosition="left" checked={appStatus.detection_active} onChange={handleToggleDetection} thumbIcon={appStatus.detection_active ? <IconPlayerPlay size="0.8rem" fill={theme.colors.green[6]} color={theme.colors.green[6]} /> : <IconPlayerPause size="0.8rem" fill={theme.colors.red[6]} color={theme.colors.red[6]} />} disabled={isTogglingDetection || isLoadingStatus} aria-live="polite" size="lg" onLabel={<Badge color="transparent" variant="filled" radius="sm">ON</Badge>} offLabel={<Badge color="red" variant="transparent" radius="sm">OFF</Badge>} styles={{ label: { marginRight: theme.spacing.xs } }} />
                  )}
                </Group>
                <Button color={appStatus?.detection_active ? 'green' : 'red'} onClick={handleRepeatAnnouncement} disabled={isRepeatingAnnouncement || ttsIsSpeaking || isLoadingStatus} loading={isRepeatingAnnouncement} leftSection={<IconVolume size={16} />} variant="outline" fullWidth mt="md">Repeat <Kbd ml="xs">R</Kbd></Button>
              </Paper>
              <Divider label={<Group gap="xs" align="center"><Text size="xs" fw={500}>Input Source</Text></Group>} labelPosition="center" my="md"/>
              {navLinks.map((item) => (<NavLink key={item.label} active={activeTab === item.value} label={item.label} leftSection={item.icon} onClick={() => { setActiveTab(item.value); if (isMobile && navbarOpened) closeNavbar(); }} variant="subtle" mb={4}/>))}
              
              <Divider label={<Group gap="xs" align="center"><Text size="xs" fw={500}>Speech Settings</Text></Group>} labelPosition="center" my="md"/>
              <Stack gap="sm">
                {isLoadingVoices && <Group justify="center"><Loader size="xs" mr="xs" /><Text size="xs">Loading voices...</Text></Group>}
                {!isLoadingVoices && ttsSupported ? (
                  <>
                    <Text size="sm">Voice</Text>
                    <Select placeholder="Select a voice" data={groupedVoiceOptions} value={selectedVoiceIdentifier} onChange={(v) => { if(v) setVoice(v);}} disabled={ttsIsSpeaking || groupedVoiceOptions.length === 0} searchable nothingFoundMessage={groupedVoiceOptions.length === 0 ? "No voices available" : "Nothing found"} maxDropdownHeight={280}/>
                    <Box><Text size="sm">Speech Rate</Text></Box>
                    <Group gap="sm" w="100%">
                      <Slider value={rate} onChange={setRate} min={isGoogleVoiceSelected ? 0.25 : 0.1} max={isGoogleVoiceSelected ? 4.0 : 10.0} step={isGoogleVoiceSelected ? 0.05 : 0.1} label={(v) => v.toFixed(isGoogleVoiceSelected ? 2 : 1)} marks={[{ value: 1 }]} disabled={ttsIsSpeaking} flex={1}/>
                      <Badge variant="outline" color="blue" radius="sm">{rate.toFixed(isGoogleVoiceSelected ? 2 : 1)}</Badge>
                    </Group>
                    <Box><Text size="sm">Pitch</Text></Box>
                    <Group gap="sm" w="100%">
                      <Slider value={pitch} onChange={setPitch} min={isGoogleVoiceSelected ? (currentGoogleVoiceSupportsPitch ? -20.0 : 0) : 0} max={isGoogleVoiceSelected ? (currentGoogleVoiceSupportsPitch ? 20.0 : 0) : 2} step={isGoogleVoiceSelected ? (currentGoogleVoiceSupportsPitch ? 0.5 : 0) : 0.1} label={(v) => v.toFixed(1)} marks={[{ value: isGoogleVoiceSelected ? (currentGoogleVoiceSupportsPitch ? 0 : 0) : 1 }]} disabled={ttsIsSpeaking || (isGoogleVoiceSelected && !currentGoogleVoiceSupportsPitch)} flex={1}/>
                      <Badge variant="outline" color="blue" radius="sm">{pitch.toFixed(1)}</Badge>
                    </Group>
                  </>
                ) : (!isLoadingVoices && <Text size="xs" c="dimmed">TTS not supported or no voices.</Text>)}
                <Switch label={<>Auto Announce <Kbd ml="xs">A</Kbd></>} labelPosition="left" checked={autoSpeakDetections} onChange={(e) => setAutoSpeakDetections(e.currentTarget.checked)} disabled={!ttsSupported} styles={{ label: { marginRight: theme.spacing.sm, flexGrow: 1 } }}/>
                <Switch label={<>Announce Scene Clear <Kbd ml="xs">C</Kbd></>} labelPosition="left" checked={announceSceneClear ?? false} onChange={handleToggleAnnounceSceneClear} disabled={isUpdatingAnnounceSetting || announceSceneClear === null || isLoadingAnnounceSetting} styles={{ label: { marginRight: theme.spacing.sm, flexGrow: 1 } }}/>
                {isLoadingAnnounceSetting && <Text size="xs">Loading 'Announce Clear'...</Text>}
                {!isLoadingAnnounceSetting && announceSceneClear === null && <Text size="xs" c="red">Could not load setting.</Text>}
              </Stack>
            </Box>
          </Stack>
        </ScrollArea>
        <Box style={{paddingTop: theme.spacing.sm}}> {/* Used colorScheme from hook */}
            <Divider label="System Status" labelPosition="center" mt="xs" mb="xs" />
            {isLoadingStatus ? <Text size="xs" ta="center">Loading status...</Text> : appStatus ? (
                <Stack gap={2} align="center"> 
                  <Text size="xs">Model: {appStatus.model_loaded ? 'Yes' : 'No'}</Text>
                  {appStatus.model_loaded && appStatus.class_names_count !== undefined && (
                    <Text size="xs">Classes: {appStatus.class_names_count}</Text>
                  )}
                </Stack> 
              ) : <Text size="xs" c="red" ta="center">System status unavailable.</Text> }
            
            <Button onClick={openShortcutsModal} variant="light" fullWidth mt="sm" leftSection={<IconKeyboard size={16}/>}>
                Shortcuts <Kbd ml="xs">H</Kbd>
            </Button>
        </Box>
      </AppShell.Navbar>

      <AppShell.Main>
        {activeTab === 'live-camera' && ( isLoadingStatus ? <Group justify="center" mt="xl"><Loader /><Text>Loading...</Text></Group> : !appStatus ? <Alert title="Error" color="red" icon={<IconAlertCircle />}>App status unavailable.</Alert> :
            <LiveDetector 
                detectionActive={appStatus.detection_active} 
                autoSpeakDetections={autoSpeakDetections} 
                speak={speak} 
                ttsIsSpeaking={ttsIsSpeaking} 
                ttsSupported={ttsSupported}
                setHotkeyActions={liveDetectorActions} // Pass the ref itself
            />)}
        {activeTab === 'file-upload' && ( isLoadingStatus ? <Group justify="center" mt="xl"><Loader /><Text>Loading...</Text></Group> : !appStatus ? <Alert title="Error" color="red" icon={<IconAlertCircle />}>App status unavailable.</Alert> :
            <ImageProcessor 
                detectionActive={appStatus.detection_active} 
                autoSpeakDetections={autoSpeakDetections} 
                speak={speak} 
                cancelSpeech={cancelSpeech} // ImageProcessor might still use cancelSpeech for its own logic
                ttsIsSpeaking={ttsIsSpeaking} 
                ttsSupported={ttsSupported}
                setHotkeyActions={imageProcessorActions} // Pass the ref itself
            />)}
      </AppShell.Main>

      <Modal opened={shortcutsModalOpened} onClose={closeShortcutsModal} title="Keyboard Shortcuts" size="xl" centered>
        <ScrollArea style={{ maxHeight: '70vh' }}>
          <Table captionSide="bottom" striped withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Key(s)</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Scope</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {APP_SHORTCUTS.map(sc => (
                <Table.Tr key={sc.description}>
                  <Table.Td>
                    {(Array.isArray(sc.keys) ? sc.keys : [sc.keys]).map(k => (
                      <Kbd key={k} style={{ marginRight: '4px' }}>{k === '?' ? 'Shift + /' : k.toUpperCase()}</Kbd>
                    ))}
                  </Table.Td>
                  <Table.Td>{sc.description}</Table.Td>
                  <Table.Td>{sc.scope || 'Global'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed" mt="md" ta="center">
            Note: Some shortcuts are contextual and may only work when the relevant tab/view is active.
          </Text>
        </ScrollArea>
      </Modal>
    </AppShell>
  );
}
export default App;