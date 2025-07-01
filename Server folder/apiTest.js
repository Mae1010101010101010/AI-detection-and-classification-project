(function() {
    'use strict';

    const API_BASE_URL = 'http://192.168.0.168:8080/'; // Adjust if your API is elsewhere

    // --- Helper Functions ---
    function logResponse(endpoint, data, isError = false) {
        console.log(`%cResponse from ${endpoint}:`, isError ? 'color: red;' : 'color: green; font-weight: bold;', data);
        if (data && data.speech_output && !isError) {
            console.log(`%c  Backend suggests saying: "${data.speech_output}"`, "color: blue; font-style: italic;");
            // Optional: Use browser TTS to speak the message
            if ('speechSynthesis' in window) {
                try {
                   const utterance = new SpeechSynthesisUtterance(data.speech_output);
                   window.speechSynthesis.speak(utterance);
                } catch (e) { console.warn("Browser TTS failed:", e); }
            } else {
                console.warn("Browser TTS (speechSynthesis) not available.");
            }
        }
    }

    function createFileInput() {
        if (document.getElementById('apiTestImageFile')) {
            return document.getElementById('apiTestImageFile');
        }
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'apiTestImageFile';
        fileInput.accept = 'image/*';

        const inputLabel = document.createElement('label');
        inputLabel.htmlFor = 'apiTestImageFile';
        inputLabel.textContent = 'Select Image for API Test: ';
        inputLabel.style.margin = "10px";
        inputLabel.style.padding = "5px";
        inputLabel.style.border = "1px solid #ccc";
        inputLabel.style.display = "inline-block";
        inputLabel.style.cursor = "pointer";


        const container = document.createElement('div');
        container.id = 'apiTestContainer';
        container.style.position = 'fixed';
        container.style.top = '10px';
        container.style.left = '10px';
        container.style.padding = '10px';
        container.style.backgroundColor = 'lightgray';
        container.style.border = '1px solid black';
        container.style.zIndex = '9999';
        container.appendChild(inputLabel);
        container.appendChild(fileInput);

        document.body.prepend(container);
        console.log('Added a file input to the top-left of the page. Select an image to test /process_image.');
        return fileInput;
    }
    const fileInput = createFileInput(); // Create it once

    // --- API Test Functions ---
    window.apiTests = {
        getStatus: async function() {
            console.log('Testing GET /status...');
            try {
                const response = await fetch(`${API_BASE_URL}/status`);
                const data = await response.json();
                logResponse('/status', data, !response.ok);
            } catch (error) {
                console.error('Error fetching status:', error);
                logResponse('/status', { error: error.message }, true);
            }
        },

        toggleDetection: async function() {
            console.log('Testing POST /toggle_detection...');
            try {
                const response = await fetch(`${API_BASE_URL}/toggle_detection`, { method: 'POST' });
                const data = await response.json();
                logResponse('/toggle_detection', data, !response.ok);
            } catch (error) {
                console.error('Error toggling detection:', error);
                logResponse('/toggle_detection', { error: error.message }, true);
            }
        },

        processImage: async function(drawBoxes = false) {
            console.log(`Testing POST /process_image (drawBoxes: ${drawBoxes})...`);
            if (!fileInput.files || fileInput.files.length === 0) {
                alert('Please select an image file first using the input at the top-left of the page.');
                console.error('No image file selected.');
                return;
            }
            const file = fileInput.files[0];
            const formData = new FormData();
            formData.append('image', file);

            const url = `${API_BASE_URL}/process_image${drawBoxes ? '?draw_boxes=true' : ''}`;

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    body: formData,
                });

                if (drawBoxes && response.ok && response.headers.get("content-type")?.startsWith("image/")) {
                    const imageBlob = await response.blob();
                    const imageUrl = URL.createObjectURL(imageBlob);
                    console.log('%cProcessed image with boxes URL (valid for this session):', 'color: green; font-weight: bold;', imageUrl);
                    let imgDisplay = document.getElementById('apiTestProcessedImage');
                    if (!imgDisplay) {
                        imgDisplay = document.createElement('img');
                        imgDisplay.id = 'apiTestProcessedImage';
                        imgDisplay.style.maxWidth = '80%';
                        imgDisplay.style.maxHeight = '500px';
                        imgDisplay.style.border = '2px solid green';
                        imgDisplay.style.display = 'block';
                        imgDisplay.style.margin = '10px auto';
                        document.getElementById('apiTestContainer').appendChild(imgDisplay);
                    }
                    imgDisplay.src = imageUrl;
                    console.log('Processed image displayed below the file input.');
                    // Attempt to get JSON data separately if speech output desired with drawn image
                    // For simplicity, we'll just log that the image was received.
                    // To get JSON too, you might make two calls or the API could return multipart.
                } else {
                    const data = await response.json();
                    logResponse(`/process_image (drawBoxes: ${drawBoxes})`, data, !response.ok);
                     if (response.ok && data.detections_json) {
                        console.log("Detections JSON:", data.detections_json);
                    }
                }
            } catch (error) {
                console.error('Error processing image:', error);
                logResponse(`/process_image (drawBoxes: ${drawBoxes})`, { error: error.message }, true);
            }
        },

        repeatLastAnnouncementText: async function() {
            console.log('Testing GET /repeat_last_announcement_text...');
            try {
                const response = await fetch(`${API_BASE_URL}/repeat_last_announcement_text`);
                const data = await response.json();
                logResponse('/repeat_last_announcement_text', data, !response.ok);
            } catch (error) {
                console.error('Error fetching last announcement text:', error);
                logResponse('/repeat_last_announcement_text', { error: error.message }, true);
            }
        },

        getAnnounceSceneClear: async function() {
            console.log('Testing GET /settings/announce_scene_clear...');
            try {
                const response = await fetch(`${API_BASE_URL}/settings/announce_scene_clear`);
                const data = await response.json();
                logResponse('/settings/announce_scene_clear (GET)', data, !response.ok);
            } catch (error) {
                console.error('Error getting announce_scene_clear setting:', error);
                logResponse('/settings/announce_scene_clear (GET)', { error: error.message }, true);
            }
        },

        setAnnounceSceneClear: async function(value) {
            console.log(`Testing POST /settings/announce_scene_clear with value: ${value}...`);
            if (typeof value !== 'boolean') {
                console.error("Value must be true or false.");
                alert("Value for setAnnounceSceneClear must be true or false.");
                return;
            }
            try {
                const response = await fetch(`${API_BASE_URL}/settings/announce_scene_clear`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: value }),
                });
                const data = await response.json();
                logResponse(`/settings/announce_scene_clear (POST: ${value})`, data, !response.ok);
            } catch (error) {
                console.error('Error setting announce_scene_clear:', error);
                logResponse(`/settings/announce_scene_clear (POST: ${value})`, { error: error.message }, true);
            }
        }
    };

    console.log(`%cThirdEye API Test Script Loaded.
API Base URL: ${API_BASE_URL}

A file input has been added to the top-left of the page. Select an image file there.

Available functions (call them like 'apiTests.getStatus()'):%c
  - apiTests.getStatus()
  - apiTests.toggleDetection()
  - apiTests.processImage(false)        // Get JSON response for selected image
  - apiTests.processImage(true)         // Get processed image with boxes for selected image
  - apiTests.repeatLastAnnouncementText()
  - apiTests.getAnnounceSceneClear()
  - apiTests.setAnnounceSceneClear(true_or_false)

Example:
1. Select an image using the input above.
2. Run: apiTests.processImage()
3. Run: apiTests.processImage(true)
   (You might want to uncomment the browser TTS part in the script for speech output)`, "font-weight:bold;", "font-weight:normal;");

})();