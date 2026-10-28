import os
import time

from flask import Flask, request, jsonify
from flask_cors import CORS
import google.generativeai as genai
from google.generativeai.types import HarmCategory, HarmBlockThreshold
from database import init_db, get_cached_result, save_result
import json

app = Flask(__name__)
# 允許跨來源請求，讓 Chrome 擴充功能可以呼叫本機 API
CORS(app)

init_db()

# 1. 設定你的 Gemini API Key
genai.configure(api_key=os.environ["GEMINI_API_KEY"])


# 初始化 Gemini 模型，並強制要求回傳 JSON 格式
model = genai.GenerativeModel(
    'gemini-3.5-flash-lite',
    generation_config={"response_mime_type": "application/json"}
)

@app.route('/analyze', methods=['POST'])
def analyze_message():
    data = request.json
    text = data.get('text', '').strip()
    
    print(f"收到前端訊息: {text}")
    
    # 2. 基礎防護：如果沒有文字，直接略過
    if not text:
        return jsonify({"risk_level": "low"})

    # 3. 規則攔截機制：過濾極短訊息或常見招呼語，加速回應時間
    safe_short_words = ["早安", "晚安", "哈哈", "ok", "好喔", "謝謝", "嗯嗯", "拜拜", "沒", "有", "好"]
    if len(text) < 3 or text.lower() in safe_short_words:
        print(f"【規則攔截】極短或安全訊息，不呼叫 AI: {text}")
        response = {"risk_level": "low", "category": "安全", "explanation": "日常短句"}
        response["id"] = data.get('id', 'unknown')
        return jsonify(response)

    # 4. 設計 Prompt (提示詞)，引導 AI 根據 165 反詐騙指標進行分析
    # 簡化 Prompt 以提升生成速度
    prompt = f"""
    分析以下訊息是否有詐騙風險。請直接回傳純 JSON 格式（不要加上 ```json 標籤），包含：
    - "risk_level": "high", "medium", 或 "low"
    - "category": 詐騙類型簡述（無風險則填 "安全"）

    訊息：「{text}」
    """

    
    # 先查詢 SQLite 是否已經分析過
    cached = get_cached_result(text)

    if cached is not None:
        print("【SQLite Cache HIT】直接使用舊結果", flush=True)

        cached["id"] = data.get("id", "unknown")
        return jsonify(cached)

    print("【SQLite Cache MISS】準備呼叫 Gemini", flush=True)

    start_time = time.perf_counter()
    print("start call gemini...", flush=True)
    
    try:
        response = model.generate_content(
            prompt,
            safety_settings={
                HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_NONE,
                HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_NONE,
                HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_NONE,
                HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE,
            },
        )
        elapsed = time.perf_counter() - start_time
        print(f"gemini time: {elapsed:.2f}", flush=True)
        # 清理可能存在的 Markdown 標籤，避
        # 免 json.loads 解析失敗
        clean_text = response.text.strip().removeprefix('```json').removesuffix('```').strip()
        
        ai_result = json.loads(clean_text)

        print("AI 判斷結果:", ai_result, flush=True)

        # 儲存分析結果到 SQLite
        risk = str(ai_result.get("risk_level", "")).lower()
        category = str(ai_result.get("category", "未知"))

        save_result(
            text=text,
            risk_level=risk,
            category=category,
            latency_ms=int(elapsed * 1000)
        )

        print("分析結果已儲存至 SQLite", flush=True)

        
        ai_result["id"] = data.get('id', 'unknown')
        print("Gemini API 已回覆！", flush=True)
        return jsonify(ai_result)
        
        
    except Exception as e:
        print(f"API 呼叫失敗: {e}", flush=True)
        return jsonify({
            "risk_level": "error",
            "category": "AI 分析失敗",
            "id": data.get("id", "unknown")
        }), 503

if __name__ == '__main__':
    app.run(debug=True, port=5000)