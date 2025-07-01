import cv2
import time
import threading
import pyttsx3
from ultralytics import YOLO
import tkinter as tk
from tkinter import Label, Button

# Load YOLOv8 model
model = YOLO("yolov8n.pt")  # Using YOLOv8 Nano for real-time performance

# Initialize pyttsx3 for speech synthesis
engine = pyttsx3.init()
engine.setProperty('rate', 150)  # Adjust speed of speech
engine.setProperty('volume', 1)  # Maximum volume

# Global control variables
running = False
last_detected_objects = set()
last_speech_time = 0  # Timestamp to control speech frequency


def speak(text):
    """Speak the detected objects using pyttsx3."""
    engine.say(text)
    engine.runAndWait()


def object_detection():
    """Continuously detect objects and announce them at intervals."""
    global running, last_detected_objects, last_speech_time
    cap = cv2.VideoCapture(0)  # Open webcam

    while running:
        ret, frame = cap.read()
        if not ret:
            break

        results = model(frame)  # Run YOLOv8 model
        frame = results[0].plot()  # Draw bounding boxes

        # Extract detected objects
        detected_objects = set()
        for r in results:
            for box in r.boxes:
                cls = int(box.cls[0])  # Get class index
                obj_name = model.names[cls]  # Get object name
                detected_objects.add(obj_name)

        # Speak objects every 2 seconds, even if they stay the same
        current_time = time.time()
        if detected_objects and (current_time - last_speech_time > 2):
            last_speech_time = current_time  # Update last speech time
            last_detected_objects = detected_objects.copy()  # Save detected objects
            objects_text = ", ".join(detected_objects)
            threading.Thread(target=speak, args=(f"I see {objects_text}",), daemon=True).start()

        # Display the detection results
        cv2.imshow("AI Object Detection for Accessibility", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):  # Stop when 'q' is pressed
            break

    cap.release()
    cv2.destroyAllWindows()


def start_detection():
    """Start the object detection thread."""
    global running
    if not running:
        running = True
        threading.Thread(target=object_detection, daemon=True).start()


def stop_detection():
    """Stop the object detection."""
    global running
    running = False


# Create GUI using Tkinter
root = tk.Tk()
root.title("AI Object Detection for Accessibility")
root.geometry("400x300")

label = Label(root, text="AI Object Detection for the Visually Impaired", font=("Arial", 14))
label.pack(pady=20)

start_btn = Button(root, text="Start Detection", font=("Arial", 12), bg="green", fg="white", command=start_detection)
start_btn.pack(pady=10)

stop_btn = Button(root, text="Stop Detection", font=("Arial", 12), bg="red", fg="white", command=stop_detection)
stop_btn.pack(pady=10)

exit_btn = Button(root, text="Exit", font=("Arial", 12), bg="gray", fg="white", command=root.quit)
exit_btn.pack(pady=10)

root.mainloop()
