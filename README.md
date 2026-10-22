# 🛡️ Anti-Fraud Chrome Extension (防詐騙網頁擴充功能)

這是一個結合 Chrome 擴充功能與 Python 後端的防詐騙系統。系統會自動監聽網頁版通訊軟體（如 Messenger）的對話內容，將新訊息傳送給本機的 Flask 伺服器，並透過 Google Gemini AI 進行語意分析。當偵測到高風險訊息（如：假冒親友借錢、釣魚連結、投資詐騙）時，會直接在聊天畫面上顯示紅色警告框，保護使用者的資訊安全。

## ✨ 功能特色
*   **即時攔截**：自動監聽通訊軟體網頁版的 DOM 變化，精準擷取最新訊息。
*   **AI 語意分析**：串接 Google Gemini AI，根據 165 反詐騙特徵進行風險評估。
*   **視覺化警告**：無縫將警告標示（紅色邊框、警示文字）嵌入原本的聊天視窗中。
*   **效能優化機制**：內建 3 秒暖機時間與短句規則過濾，避免剛開網頁時的歷史訊息耗盡 API 額度，並大幅降低日常對話的延遲。

## 🛠️ 系統需求
*   **Python 3.8 或以上版本** (請確保安裝時有勾選 `Add Python to PATH`)
*   **Google Chrome 瀏覽器**
*   **Google Gemini API Key** (可至 Google AI Studio 免費申請)

---

## 🚀 專案啟動教學

### 步驟一：後端伺服器設定 (Python)

1.  **安裝必備套件**
    打開終端機 (Terminal) 或 PowerShell，確認路徑在您的專案資料夾下，輸入以下指令安裝模組：
    ```bash
    pip install flask flask-cors google-generativeai
    ```

2.  **設定 Gemini API Key**
    *   前往 [Google AI Studio](https://aistudio.google.com/) 登入您的 Google 帳號。
    *   點擊畫面中的「Get API key」或鑰匙圖示來建立並複製您的專屬金鑰。
    *   打開專案裡的 `app.py`，找到設定 API Key 的程式碼，將金鑰貼上：
        ```python
        genai.configure(api_key="在這裡貼上你的API_KEY")
        ```
    ⚠️ **極度重要：請絕對不要把含有真實 API Key 的 `app.py` 上傳到公開的 GitHub 上！上傳前請務必將金鑰替換為預設字串。**

3.  **啟動後端伺服器**
    在終端機中執行以下指令：
    ```bash
    python app.py
    ```
    若顯示 `Running on http://127.0.0.1:5000`，代表伺服器已成功啟動。(測試期間請保持此終端機視窗開啟)

### 步驟二：前端擴充功能設定 (Chrome)

1.  打開 Google Chrome 瀏覽器。
2.  在網址列輸入 `chrome://extensions/` 進入擴充功能管理頁面。
3.  開啟畫面右上角的 **「開發人員模式」(Developer mode)**。
4.  點擊左上角的 **「載入未封裝項目」(Load unpacked)**。
5.  選擇您存放本專案的「資料夾」即可成功載入防詐騙擴充功能。

---

## 🧪 如何測試？

1.  確認 Python 伺服器正在運行中。
2.  打開 [Messenger 網頁版](https://www.messenger.com/) 並重新整理網頁 (F5)。
3.  **等待暖機**：系統啟動前 3 秒不會進行分析。請等待 3 秒後再進行測試。
4.  在聊天室中傳送以下「測試詐騙台詞」：
    > 「兄弟，我剛剛出車禍了，現在人在醫院急診室，身上沒帶錢。你能不能先幫我匯個 3 萬塊到這個新帳號？我下週一領薪水馬上還你，拜託很急！」
5.  送出後，該則訊息氣泡會自動變成紅色邊框，並在下方顯示 AI 的警告與防範建議！

## 📂 核心檔案結構
*   `manifest.json`: Chrome 擴充功能設定檔與權限宣告。
*   `content.js`: 負責監聽網頁訊息、繪製警告畫面，並與後端通訊的前端腳本。
*   `app.py`: 接收前端請求並呼叫 Gemini AI 模型進行分析的 Flask 後端伺服器。
