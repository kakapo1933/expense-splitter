# 前端設計研究：分帳 app 的手機設計慣例

目的：在動手畫設計稿前，先確認市面上分帳 app（Splitwise、Tricount、Settle Up）在手機上
已被使用者學會的慣例，決定本專案採用哪些、放棄哪些。評分表 Frontend 20% 看兩件事：
「用手機記一筆支出要多快」與「誰欠誰是否一眼看懂」，研究圍繞這兩點。

每條慣例一句話加來源。來源分三級：**官方**（該 app 的幫助中心／tips）、**二手**（評測、
第三方教學）、**通則**（與分帳無關的表單設計文獻）。二手來源只用來佐證，不作唯一依據。

## 1. 記一筆支出的最短路徑

| # | 慣例 | 來源 |
|---|------|------|
| 1.1 | Splitwise 的新增支出只有兩個必填欄位：描述與金額；付款人與分法以一句話「Paid by **you** and split **equally**」呈現，點該字才展開選項。 | 官方：[Splitwise KB – What are different ways I can split an expense?](https://kb.splitwise.com/balances-and-expenses/what-are-different-ways-i-can-split-an-expense) |
| 1.2 | 平分時「點名字即移除該人」，不另開選人畫面。 | 官方：同上 |
| 1.3 | Settle Up 把「誰該付下一筆」做成最大的圓圈放中央，點圓圈直接以該人為付款人開新支出；標記「This is me」後往後預選自己為付款人。 | 官方：[Settle Up Tips](https://settleup.io/tips) |
| 1.4 | 長按一筆交易可編輯或複製（duplicate），縮短重複記帳。 | 官方：Settle Up Tips |
| 1.5 | 金額欄用 `type="text" inputmode="decimal"`，不用 `type="number"`（spinner 會把 1.5 四捨五入、iOS 可能插入千分位）；`numeric` 在部分 iOS 沒有小數點。 | 通則：[etch.co – Money input](https://etch.co/blog/money-input)、[Brad Frost – Better numerical inputs](https://bradfrost.com/?p=2664) |
| 1.6 | 金額欄前綴貨幣符號、placeholder 用 0 而非範例價格、label 不能只靠 placeholder（螢幕閱讀器不唸）。 | 通則：etch.co |

## 2. 餘額與「誰欠誰」

| # | 慣例 | 來源 |
|---|------|------|
| 2.1 | Tricount 餘額頁：別人欠你 → 綠色加 `+` 號；你欠人 → 紅色加 `-` 號。顏色與符號並用，不只靠色。 | 官方站說明（經 [pilotplans 評測](https://www.pilotplans.com/blog/tricount-review) 與 [tricount.com](https://www.tricount.com/) 轉述） |
| 2.2 | Tricount 的餘額分兩步：先算每人多付／少付，再提出一組「盡量少筆」的還款建議；因此你可能要付錢給沒替你付過錢的人，幫助中心特別解釋這點。 | 官方：[Tricount FAQs](https://help.tricount.com/articles/tricount-faqs)、[How does Tricount calculate my balance](https://tricount.com/en/how-does-Tricount-calculate-my-balance) |
| 2.3 | Tricount 明寫精度 1 cent，使用者可預期 0.01 的誤差。 | 官方：Tricount FAQs |
| 2.4 | Settle Up 用圓圈大小表示債務大小，最大者置中＝下一個該付錢的人；可關閉 debt minimization 只付直接債務。 | 官方：Settle Up Tips |
| 2.5 | Splitwise 的 simplify debts 預設關閉，理由是朋友間信任程度不同。 | 二手：Splitwise 共同創辦人 HN 留言（經搜尋摘要轉述，年代較舊，待確認） |
| 2.6 | 還款建議在 Tricount 可直接「Mark as paid」，或新增一筆 transfer 型交易。 | 官方：Tricount FAQs |
| 2.7 | 零餘額用灰色，與正負區分（三態）。 | 二手：[BillBuddy docs](https://www.mintlify.com/rahilmavani/BillBuddy/guides/settling-debts)（開源專案，非三大 app） |

## 3. 分法切換（平分／精確／百分比）

| # | 慣例 | 來源 |
|---|------|------|
| 3.1 | Splitwise 提供 equally／exact amounts／percentage／shares／adjustment 五種；前三種是「首層選項」，其餘藏在 More options。 | 官方：Splitwise KB |
| 3.2 | 精確金額要加總等於總額、百分比要加總 100，否則不能存；這是所有實作的共通驗證。 | 二手：[algomaster – Design Splitwise](https://algomaster.io/learn/lld/design-splitwise)（與本專案 SPEC 一致） |
| 3.3 | Splitwise 使用者抱怨：編輯不平分支出時只看到結果金額，看不到原本輸入的 % 或 shares。 | 官方論壇：[feedback.splitwise.com](https://feedback.splitwise.com/forums/162446-general/suggestions/3465674-when-editing-an-unequal-split-load-the-entered) |
| 3.4 | Settle Up 用「default share」讓情侶／家庭算兩份，長按成員可只選該人。 | 官方：Settle Up Tips |

## 4. 取整餘數如何告知使用者

| # | 慣例 | 來源 |
|---|------|------|
| 4.1 | 三大 app 都**不**主動解釋餘數去哪，Tricount 只在 FAQ 說「可能差 1 cent」。 | 官方：Tricount FAQs；Splitwise／Settle Up 官方頁面未提及 |
| 4.2 | 常見實作：多出的 cent 給第一位成員或付款人，$100/3 → 33.34/33.33/33.33；較友善的做法是讓使用者看見分配結果。 | 二手：[hackernoon – tip calculator that doesn't lose a cent](https://hackernoon.com/how-to-build-a-tip-calculator-that-doesnt-lose-a-cent)、[money.readthedocs Allocation](https://money.readthedocs.io/en/1.x/Allocation.html)（largest remainder） |

## 5. 本專案採用／不採用

### 採用

- **描述 + 金額 + Save 的三步路徑**（1.1）：付款人預設上次、分法預設全員平分，其餘欄位都有預設值可直接送出。SPEC 已明訂，研究證實是業界慣例。
- ~~**一句話式的預設摘要**（1.1）~~ → **改為預設展開**：第一版做成「Kai paid · split equally among 3」摘要列、點擊才展開付款人／分法控件。使用者實測（2026-10-25）發現這列灰字小字、像提示文字，容易被忽略；Splitwise 的做法有效是因為把 you／equally 做成 accent 粗體連結，我們沒沿用那個視覺線索。決定改為付款人與分法永遠顯示：最短路徑仍是描述 + 金額 + Save（預設值不變），只多佔垂直空間，且使用者能直接看到「預設平分給 5 人」當作確認。
- **點名字即移除／加入平分對象**（1.2）：平分模式用成員 chips 多選，不另開畫面。
- **`type=text inputmode=decimal` + `$` 前綴 + placeholder `0.00`**（1.5、1.6）。
- **正負雙編碼**（2.1、2.7）：綠 `+$12.34`／紅 `−$12.34`／灰 `settled`，顏色與符號並用，色盲也能讀。
- **還款建議獨立成區塊，方向用「A → B $x」一行一筆**（2.2）：這是評分表「誰欠誰一眼看懂」的直接對應；清單標題寫「2 payments settle everyone」讓人知道這已是精簡版。
- **分法三模式用 segmented control**（3.1）：本專案只有三種，不需要 Splitwise 的 More options 層級；三個並排一眼可見。
- **編輯時回填原輸入**（3.3）：後端已存 `input_value`，編輯表單顯示原本的 33.33% 而非 33.33 元，避開 Splitwise 使用者抱怨的問題。
- **即時顯示每人分到多少與餘數歸誰**（4.1、4.2）：三大 app 都不做，但本專案的加分點是「取整規則透明」；在 sheet 底部列出 Kai $33.34 · Mia $33.33 · Leo $33.33，並以小字標「extra ¢ → Kai (first member)」。
- **連線狀態小點**：SSE 是加分項，用 header 的綠點＋「live」文字表達，斷線變灰「reconnecting…」。

### 不採用

- **Settle Up 的圓圈視覺**（2.4）：圓圈大小表債務需要動畫與版面計算，一小時作業不值得；且面積比較不如數字精確。
- **shares／adjustment 分法**（3.1、3.4）：SPEC 只要三種；shares 可用 percent 表達，adjustment 可用 exact。
- **Mark as paid / 記錄還款**（2.6）：SPEC 列為 out of scope，但設計稿在 settle 列預留右側空位，現場加功能時放按鈕即可。
- **simplify debts 可開關**（2.5）：後端只有 greedy 一種結果，前端不做切換；在 settle 標題註明「fewest payments」即可。
- **複製一筆支出**（1.4）：有用但非評分重點，列為 nice-to-have。

### 待確認

- Splitwise 目前版本 simplify debts 是否仍預設關閉（來源為多年前留言）。
- Settle Up 的正負色彩實際用色（官方 tips 未提，搜尋只找到第三方專案）。
