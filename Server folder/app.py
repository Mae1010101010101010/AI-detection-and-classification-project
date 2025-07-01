# app.py
# Core libraries
import cv2
import numpy as np
import os
import pickle
import logging
import time
from collections import deque, Counter
import io
import base64 # Ensure base64 is imported

# ONNX Runtime
import onnxruntime 

# Flask
from flask import Flask, request, jsonify, send_file, make_response
from PIL import Image
from flask_cors import CORS

# Google Cloud TTS
from google.cloud import texttospeech
from dotenv import load_dotenv

# --- Application Setup ---
load_dotenv() 
app = Flask(__name__)
CORS(app) 
app.config['SECRET_KEY'] = os.getenv('FLASK_SECRET_KEY', 'a_very_secure_default_secret_key')

try:
    google_tts_client = texttospeech.TextToSpeechClient()
    logging.info("Google TextToSpeechClient initialized successfully.")
except Exception as e:
    google_tts_client = None
    logging.error(f"Failed to initialize Google TextToSpeechClient: {e}", exc_info=True)
    logging.error("Google Cloud TTS functionality will be unavailable.")

# --- Configuration Constants & Global Variables ---
CURATED_OBJECT_CLASS_CANDIDATES = [
    'person', 'backpack', 'handbag', 'suitcase', 'umbrella', 'bicycle', 'car',
    'motorcycle', 'bus', 'truck', 'boat', 'airplane', 'traffic light',
    'stop sign', 'fire hydrant', 'parking meter', 'bench', 'street sign', 'bird',
    'cat', 'dog', 'horse', 'sheep', 'cow', 'chair', 'sofa', 'potted plant',
    'bed', 'dining table', 'table', 'desk', 'toilet', 'door', 'window',
    'bookshelf', 'cabinet', 'television', 'tv', 'monitor', 'laptop', 'mouse',
    'remote control', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster',
    'sink', 'refrigerator', 'blender', 'book', 'clock', 'vase', 'scissors',
    'teddy bear', 'hair drier', 'toothbrush', 'bottle', 'cup', 'fork', 'knife',
    'spoon', 'bowl', 'plate', 'tennis racket', 'baseball bat', 'sports ball',
    'skateboard', 'building', 'house', 'sky', 'tree', 'road', 'sidewalk',
    'wall', 'floor', 'ceiling', 'stairs', 'pole', 'fence', 'signboard',
    'light', 'light source', 'cushion', 'pillow'
]
CONF_THRESHOLD = 0.37
NMS_THRESHOLD = 0.35
SPEECH_CONF_THRESHOLD = 0.30
TTS_ANNOUNCEMENT_COOLDOWN = 5.0 
DEFAULT_ANNOUNCE_SCENE_CLEAR = True
DEFAULT_BOUNDING_BOX_FONT_SCALE = 0.5

class_names = []
onnx_session = None
model_input_name = None
model_input_shape = None
detection_active = True
announce_scene_clear = DEFAULT_ANNOUNCE_SCENE_CLEAR
last_generated_speech_text = "" 
last_semantic_summary_set = set() 
last_announcement_text_generation_time = 0 
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Helper Functions (Assumed unchanged from your full version) ---
def load_class_names_from_pickle(p):
    global class_names
    logging.info(f"Loading class names from: {p}"); fnl=[]
    if not os.path.exists(p): logging.error(f"Pickle {p} not found."); return fnl
    try:
        with open(p,'rb') as f: d=pickle.load(f)
        if 'objectnames' not in d: logging.error("'objectnames' missing."); return fnl
        names_from_pickle=list(d['objectnames'])
        verified=[]
        for c in CURATED_OBJECT_CLASS_CANDIDATES:
            if c in names_from_pickle: verified.append(c)
            else:
                for dn in names_from_pickle:
                    if c==dn.split(',')[0].strip(): verified.append(dn); break
        class_names=sorted(list(set(verified)))
        logging.info(f"Loaded {len(class_names)} class names.")
    except Exception as e: logging.error(f"Error loading pickle {p}: {e}", exc_info=True)
    return class_names

def load_onnx_model(p):
    global onnx_session, model_input_name, model_input_shape
    logging.info(f"Loading ONNX model: {p}")
    if not os.path.exists(p): logging.error(f"ONNX model {p} not found."); return
    try:
        onnx_session=onnxruntime.InferenceSession(p,providers=['CPUExecutionProvider'])
        model_input_name=onnx_session.get_inputs()[0].name
        model_input_shape=onnx_session.get_inputs()[0].shape
        logging.info(f"ONNX: Input:'{model_input_name}' Shape:{model_input_shape}")
    except Exception as e: logging.error(f"Error loading ONNX {p}: {e}", exc_info=True); onnx_session=None

def preprocess_frame_for_onnx(f_bgr):
    global model_input_shape
    if model_input_shape is None: return None,0.0,0,0
    _,_,ih,iw=model_input_shape; imh,imw,_=f_bgr.shape
    if imw==0 or imh==0: logging.warning("Invalid frame dims in preprocess."); return None,0.0,0,0
    s=min(iw/imw,ih/imh); nw,nh=int(imw*s),int(imh*s)
    if nw<=0 or nh<=0: logging.warning(f"Invalid new dims {nw}x{nh}."); return None,0.0,0,0
    rsz=cv2.resize(f_bgr,(nw,nh),interpolation=cv2.INTER_LINEAR)
    pad=np.full((ih,iw,3),114,dtype=np.uint8); dw,dh=(iw-nw)//2,(ih-nh)//2
    pad[dh:dh+nh,dw:dw+nw,:]=rsz; rgb=cv2.cvtColor(pad,cv2.COLOR_BGR2RGB)
    chw=np.transpose(rgb,(2,0,1)); norm=chw/255.0
    return np.expand_dims(norm,axis=0).astype(np.float32),s,dw,dh

def perform_inference_and_postprocess(frame_bgr, original_width, original_height):
    global onnx_session, model_input_name, class_names, DEFAULT_BOUNDING_BOX_FONT_SCALE
    input_tensor, scale, dw, dh = preprocess_frame_for_onnx(frame_bgr.copy())
    if input_tensor is None or scale == 0: return [], frame_bgr, []
    detections_info = []; detections_json = []; frame_draw = frame_bgr.copy()
    if not onnx_session: return ["ONNX model not loaded."], frame_draw, []
    try:
        outputs = onnx_session.run(None, {model_input_name: input_tensor})
        proposals = outputs[0][0].transpose(); b_m, cf_m, cls_m = [],[],[]
        num_cls = len(class_names)
        for p_idx in range(proposals.shape[0]):
            prop = proposals[p_idx]
            if prop.shape[0] < (4 + num_cls): continue
            class_scores=prop[4:4+num_cls]; c_id=np.argmax(class_scores); m_s=class_scores[c_id]
            if m_s > CONF_THRESHOLD: b_m.append(prop[0:4]); cf_m.append(float(m_s)); cls_m.append(c_id)
        cv_b = [[int(b[0]-b[2]/2),int(b[1]-b[3]/2),int(b[2]),int(b[3])] for b in b_m]
        indices = []
        if cv_b:
            indices = cv2.dnn.NMSBoxes(cv_b, cf_m, CONF_THRESHOLD, NMS_THRESHOLD)
            if isinstance(indices, np.ndarray): indices = indices.flatten()
        if len(indices) > 0:
            for i in indices:
                c_id=cls_m[i];
                if c_id>=num_cls: continue
                c_n=class_names[c_id]; score=cf_m[i]; cx,cy,w,h=b_m[i]
                ox,oy,ow,oh=(cx-dw)/scale,(cy-dh)/scale,w/scale,h/scale
                x1,y1,x2,y2=int(ox-ow/2),int(oy-oh/2),int(ox+ow/2),int(oy+oh/2)
                x1c,y1c,x2c,y2c=max(0,x1),max(0,y1),min(original_width-1,x2),min(original_height-1,y2)
                if x1c<x2c and y1c<y2c:
                    cv2.rectangle(frame_draw,(x1c,y1c),(x2c,y2c),(0,255,0),2)
                    cv2.putText(frame_draw,f"{c_n.split(',')[0]}:{score:.2f}",(x1c,y1c-10),
                                cv2.FONT_HERSHEY_SIMPLEX, DEFAULT_BOUNDING_BOX_FONT_SCALE, (0,255,0),1)
                    obj_cx=(x1c+x2c)/2; direction="front"
                    if obj_cx < original_width/2 - original_width*0.1: direction="left"
                    elif obj_cx > original_width/2 + original_width*0.1: direction="right"
                    detections_info.append(f"{c_n.split(',')[0]} ({direction}) [{score:.2f}]")
                    detections_json.append({
                        "class_name": c_n.split(',')[0], "score": float(f"{score:.2f}"),
                        "direction": direction, "bbox": [x1c, y1c, x2c, y2c]})
        else: detections_info.append(f"No objects (Conf:{CONF_THRESHOLD},NMS:{NMS_THRESHOLD}).")
    except Exception as e:
        logging.error(f"Infer/Postproc error: {e}",exc_info=True); detections_info.append("Infer Error.")
    return detections_info, frame_draw, detections_json

def natural_join(items_list):
    if not items_list: return ""
    if len(items_list) == 1: return items_list[0]
    if len(items_list) == 2: return f"{items_list[0]} and {items_list[1]}"
    return ", ".join(items_list[:-1]) + f", and {items_list[-1]}"

def format_object_with_count(name, count):
    if name.endswith('s') or name.endswith('sh') or name.endswith('ch') or name.endswith('x') or name.endswith('z'):
        plural_name = name + "es"
    elif name.endswith('y') and name[-2] not in "aeiou":
        plural_name = name[:-1] + "ies"
    else: plural_name = name + "s"
    if count == 1: return f"an {name}" if name[0].lower() in "aeiou" else f"a {name}"
    elif count == 2: return f"two {plural_name}"
    elif count == 3: return f"three {plural_name}"
    else: return f"{count} {plural_name}"

def generate_speech_summary_from_detections_strings(detections_list_strings):
    global SPEECH_CONF_THRESHOLD
    if not detections_list_strings: return None, set()
    first_item = detections_list_strings[0]
    if "No objects" in first_item or "Error" in first_item: return None, set()
    objects_by_direction = {"left": Counter(), "right": Counter(), "front": Counter()}
    current_semantic_set = set()
    for item_str in detections_list_strings:
        try:
            name_part, rest_of_item = item_str.split(' (', 1)
            direction_part, score_part = rest_of_item.split(') [', 1)
            score = float(score_part.rstrip(']'))
            if score < SPEECH_CONF_THRESHOLD: continue
            primary_class_name = name_part.split(',')[0].strip()
            direction = direction_part.strip().lower()
            current_semantic_set.add((primary_class_name, direction))
            if direction in objects_by_direction: objects_by_direction[direction][primary_class_name] += 1
        except ValueError: logging.warning(f"Could not parse item for speech: {item_str}")
        except Exception as e: logging.error(f"Error parsing for speech: {item_str} - {e}")
    summary_clauses = []
    if objects_by_direction["front"]:
        front_items = [format_object_with_count(n, c) for n, c in objects_by_direction["front"].items()]
        if front_items: summary_clauses.append(f"in front of you, there's {natural_join(front_items)}")
    if objects_by_direction["left"]:
        left_items = [format_object_with_count(n, c) for n, c in objects_by_direction["left"].items()]
        if left_items:
            connector = "while to your left, you'll find" if summary_clauses else "to your left, there's"
            summary_clauses.append(f"{connector} {natural_join(left_items)}")
    if objects_by_direction["right"]:
        right_items = [format_object_with_count(n, c) for n, c in objects_by_direction["right"].items()]
        if right_items:
            connector = "and to your right," if summary_clauses else "to your right, there's"
            summary_clauses.append(f"{connector} {natural_join(right_items)}")
    if not summary_clauses: return None, current_semantic_set
    final_summary = summary_clauses[0]
    if len(summary_clauses) > 1: final_summary += ", " + ", ".join(summary_clauses[1:])
    final_summary += "."
    if not final_summary.strip() or final_summary == ".": return None, current_semantic_set
    return final_summary.strip(), current_semantic_set

# --- Flask Routes ---
@app.route('/status', methods=['GET'])
def get_status():
    return jsonify({
        "detection_active": detection_active, "model_loaded": onnx_session is not None,
        "model_input_name": model_input_name, "model_input_shape": model_input_shape,
        "class_names_count": len(class_names)})

@app.route('/toggle_detection', methods=['POST'])
def toggle_detection():
    global detection_active, last_generated_speech_text
    detection_active = not detection_active
    speech_text = "Detection Paused." if not detection_active else "Detection Resumed."
    last_generated_speech_text = speech_text
    return jsonify({"message": speech_text, "speech_output": speech_text, "detection_active": detection_active})

@app.route('/process_image', methods=['POST'])
def process_image_route():
    global detection_active, last_generated_speech_text, last_semantic_summary_set, last_announcement_text_generation_time, announce_scene_clear
    if not detection_active: return jsonify({"message": "Detection is paused.", "detections_json": [], "speech_output": "Detection is currently paused."}), 423
    if 'image' not in request.files: return jsonify({"error": "No image file provided."}), 400
    file = request.files['image']
    if file.filename == '': return jsonify({"error": "No selected file."}), 400
    try:
        img_bytes = file.read(); pil_image = Image.open(io.BytesIO(img_bytes))
        frame_bgr = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
        vid_height, vid_width, _ = frame_bgr.shape
    except Exception as e: return jsonify({"error": f"Could not process image: {e}"}), 400
    if not onnx_session: return jsonify({"error": "ONNX model not loaded."}), 503
    detection_strings, processed_frame, detections_json_data = perform_inference_and_postprocess(frame_bgr, vid_width, vid_height)
    generated_summary_text, current_semantic_set = generate_speech_summary_from_detections_strings(detection_strings)
    time_now = time.time()
    speech_for_this_response = None
    if generated_summary_text: speech_for_this_response = generated_summary_text
    elif announce_scene_clear and last_semantic_summary_set: speech_for_this_response = "Scene clear."
    make_new_announcement = False
    if speech_for_this_response:
        if speech_for_this_response == "Scene clear.":
            if last_semantic_summary_set: make_new_announcement = True
        elif current_semantic_set != last_semantic_summary_set or not last_semantic_summary_set : make_new_announcement = True
    if make_new_announcement and (time_now - last_announcement_text_generation_time > TTS_ANNOUNCEMENT_COOLDOWN):
        last_generated_speech_text = speech_for_this_response
        last_semantic_summary_set = set() if speech_for_this_response == "Scene clear." else current_semantic_set
        last_announcement_text_generation_time = time_now
    if request.args.get('draw_boxes', 'false').lower() == 'true':
        is_success, buffer = cv2.imencode(".jpg", processed_frame)
        if is_success: return send_file(io.BytesIO(buffer), mimetype='image/jpeg')
    return jsonify({"detections_text": detection_strings, "detections_json": detections_json_data, "speech_output": speech_for_this_response})

@app.route('/repeat_last_announcement_text', methods=['GET'])
def get_last_announcement_text_route():
    if last_generated_speech_text: return jsonify({"speech_output": last_generated_speech_text})
    return jsonify({"speech_output": None, "message": "No previous announcement."}), 404

@app.route('/settings/announce_scene_clear', methods=['GET', 'POST'])
def setting_announce_scene_clear_route():
    global announce_scene_clear
    if request.method == 'POST':
        data = request.get_json()
        if data and 'value' in data and isinstance(data['value'], bool):
            announce_scene_clear = data['value']
            return jsonify({"message": f"Announce scene clear set to {announce_scene_clear}", "value": announce_scene_clear})
        return jsonify({"error": "Invalid payload."}), 400
    return jsonify({"value": announce_scene_clear})

@app.route('/google_tts_voices', methods=['GET'])
def get_google_tts_voices():
    if not google_tts_client:
        return jsonify({"error": "Google TTS Client not initialized.", "voices": []}), 503
    try:
        voices_response = google_tts_client.list_voices()
        processed_voices = []
        PITCH_UNSUPPORTED_PATTERNS = ["chirp", "journey"] 

        for voice in voices_response.voices:
            supports_pitch = not any(pattern in voice.name.lower() for pattern in PITCH_UNSUPPORTED_PATTERNS)
            voice_data = {
                "name": voice.name,
                "language_codes": list(voice.language_codes),
                "ssml_gender": texttospeech.SsmlVoiceGender(voice.ssml_gender).name,
                "natural_sample_rate_hertz": voice.natural_sample_rate_hertz,
                "type": "google",
                "supportsPitch": supports_pitch
            }
            processed_voices.append(voice_data)
        
        english_voices = [v for v in processed_voices if any(lc.startswith("en-") for lc in v["language_codes"])]
        english_voices.sort(key=lambda x: (x["language_codes"][0], x["name"]))
        
        limit = 75 
        logging.info(f"Returning up to {limit} English Google TTS voices. Total English voices found: {len(english_voices)}.")
        return jsonify({"voices": english_voices[:limit]})
    except Exception as e:
        logging.error(f"Error fetching Google TTS voices: {e}", exc_info=True)
        return jsonify({"error": str(e), "voices": []}), 500

@app.route('/synthesize_speech_google', methods=['POST'])
def synthesize_speech_google_route():
    if not google_tts_client:
        return jsonify({"error": "Google TTS Client not initialized."}), 503
    data = request.get_json()
    text_input = data.get('text')
    language_code = data.get('languageCode', 'en-US')
    voice_name = data.get('voiceName')
    speaking_rate_req = float(data.get('speakingRate', 1.0))
    pitch_req = float(data.get('pitch', 0.0))

    if not text_input: return jsonify({"error": "No text provided"}), 400
    if not voice_name: return jsonify({"error": "No voiceName provided"}), 400

    synthesis_input = texttospeech.SynthesisInput(text=text_input)
    voice_params = texttospeech.VoiceSelectionParams(language_code=language_code, name=voice_name)
    speaking_rate = max(0.25, min(4.0, speaking_rate_req))
    audio_config_args = {"audio_encoding": texttospeech.AudioEncoding.MP3, "speaking_rate": speaking_rate}

    PITCH_UNSUPPORTED_PATTERNS = ["chirp", "journey"] 
    if not any(pattern in voice_name.lower() for pattern in PITCH_UNSUPPORTED_PATTERNS):
        pitch = max(-20.0, min(20.0, pitch_req))
        audio_config_args["pitch"] = pitch
    else:
        logging.info(f"Pitch parameter omitted for voice {voice_name}.")
    audio_config = texttospeech.AudioConfig(**audio_config_args)

    try:
        response = google_tts_client.synthesize_speech(
            request={"input": synthesis_input, "voice": voice_params, "audio_config": audio_config}
        )
        audio_base64 = base64.b64encode(response.audio_content).decode('utf-8')
        return jsonify({"audioContent": audio_base64})
    except Exception as e:
        logging.error(f"Google TTS synthesis error for voice {voice_name}: {e}", exc_info=True)
        error_message = str(e)
        if hasattr(e, 'message'): error_message = e.message
        if "pitch" in error_message.lower() and ("support" in error_message.lower() or "invalid" in error_message.lower()):
             return jsonify({"error": f"Voice '{voice_name}' does not support pitch. (API: {error_message})"}), 400
        return jsonify({"error": f"Failed to synthesize speech with Google: {error_message}"}), 500

# --- Initialization ---
def initialize_app():
    logging.info("Initializing ThirdEye API...")
    class_names_path = os.getenv("CLASS_NAMES_PATH", "index_ade20k.pkl")
    model_path = os.getenv("MODEL_PATH", "best.onnx")
    if not os.path.exists(class_names_path): logging.critical(f"Class names file not found: {class_names_path}.")
    else: load_class_names_from_pickle(class_names_path)
    if not os.path.exists(model_path): logging.critical(f"ONNX model file not found: {model_path}.")
    else: load_onnx_model(model_path)
    logging.info("ThirdEye API Initialized.")

if __name__ == "__main__":
    initialize_app()
    app.run(debug=True, host='0.0.0.0', port=8080, use_reloader=False)