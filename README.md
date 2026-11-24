# Anti-Fraud Messaging Alert 1.1.0

Chrome 擴充功能會在 Messenger、Instagram 和 WhatsApp 網頁版分析進入畫面的訊息。高風險結果會在原訊息旁顯示類別與建議。翻閱歷史紀錄也可能觸發分析。

## 安裝

在專案根目錄以 PowerShell 執行以下指令。後端使用本機 SQLite 快取；需要模型判斷時，會將訊息文字送往 Gemini。

```powershell
python -m pip install -r backend/requirements.txt
$env:GEMINI_API_KEY = '填入自己的金鑰'
python backend/app.py
```

開啟 chrome://extensions，啟用開發人員模式，選擇「載入未封裝項目」並指定 extension 資料夾，再重新整理聊天室。

## 使用

預設逐句分析。在 Messenger 點選目標文字後按 Alt+Shift+R，可預覽並送出前文複核，最多包含前五則訊息。辨識到聊天室容器後，可在對話框啟用該聊天室的高風險自動複核。遇到用量限制時，畫面會標示尚未分析，並提供單則重試。

## 離線回歸測試

後端可執行 python tests/test_backend.py。瀏覽器測試需要 Node.js、Playwright 與 Chrome，執行 node tests/browser.cjs，可使用 CHROME_PATH 指定 Chrome 執行檔。兩套測試均使用模擬模型回應。
