import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { DragDropContext, Droppable, Draggable, DropResult } from "react-beautiful-dnd";


type StockQuote = {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  change_percent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  quote_time: string;
};

type MarketSnapshot = {
  quotes: StockQuote[];
  updated_at: string;
  source: string;
};

const STOCK_CODES_STORAGE_KEY = "xiaobaisha.stockCodes";
const DISPLAY_MODE_STORAGE_KEY = "xiaobaisha.displayMode";
const HOLDINGS_STORAGE_KEY = "xiaobaisha.holdings";

const SHOW_MINIMAL_TOTAL_KEY = "xiaobaisha.showMinimalTotal";

function readShowMinimalTotal(): boolean {
  const raw = window.localStorage.getItem(SHOW_MINIMAL_TOTAL_KEY);
  return raw === null ? true : raw === "true";
}

function saveShowMinimalTotal(show: boolean) {
  window.localStorage.setItem(SHOW_MINIMAL_TOTAL_KEY, String(show));
}

type Holding = {
  cost?: number;
  qty?: number;
  customName?: string;
};

type HoldingsMap = Record<string, Holding>;

function readHoldings(): HoldingsMap {
  const raw = window.localStorage.getItem(HOLDINGS_STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveHoldings(holdings: HoldingsMap) {
  window.localStorage.setItem(HOLDINGS_STORAGE_KEY, JSON.stringify(holdings));
}

const formatter2Decimals = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const formatter3Decimals = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 3,
  minimumFractionDigits: 3,
});

const formatter = formatter2Decimals;

const amountFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

function getPrecision(symbol: string): number {
  const code = symbol.trim();
  // 5或1开头的场内基金/ETF，以及可转债，在业内交易所行情规则中一般都规定保留3位小数
  if (code.startsWith("5") || code.startsWith("1")) {
    return 3;
  }
  return 2;
}

function formatPrice(value: number | null, symbol?: string) {
  if (value === null) {
    return "--";
  }
  if (symbol && getPrecision(symbol) === 3) {
    return formatter3Decimals.format(value);
  }
  return formatter2Decimals.format(value);
}

function formatChange(value: number | null, suffix = "") {
  if (value === null) {
    return "--";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatter.format(value)}${suffix}`;
}

function readStockCodes(): string[] {
  const rawValue = window.localStorage.getItem(STOCK_CODES_STORAGE_KEY);
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function saveStockCodes(codes: string[]) {
  window.localStorage.setItem(STOCK_CODES_STORAGE_KEY, codes.join(","));
}

function readMinimalMode() {
  return window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY) === "minimal";
}

function saveMinimalMode(enabled: boolean) {
  window.localStorage.setItem(
    DISPLAY_MODE_STORAGE_KEY,
    enabled ? "minimal" : "normal"
  );
}

function getMinimalLabel(name: string, symbol: string) {
  return name.trim().charAt(0) || symbol.charAt(0);
}

function App() {
  const [stockCodes, setStockCodes] = useState<string[]>(() => readStockCodes());
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [status, setStatus] = useState<string>("启动中");
  const [inputValue, setInputValue] = useState<string>("");
  const [minimalMode, setMinimalMode] = useState<boolean>(() =>
    readMinimalMode()
  );

  const [holdings, setHoldings] = useState<HoldingsMap>(() => readHoldings());
  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const [editCost, setEditCost] = useState<string>("");
  const [editQty, setEditQty] = useState<string>("");
  const [editCustomName, setEditCustomName] = useState<string>("");
  const [showMinimalTotal, setShowMinimalTotal] = useState<boolean>(() =>
    readShowMinimalTotal()
  );
  const [contextMenu, setContextMenu] = useState<{
    symbol: string;
    x: number;
    y: number;
  } | null>(null);

  const holdingCodes = stockCodes.filter((code) => holdings[code]);

  // 窗口尺寸自适应极简模式/普通模式
  useEffect(() => {
    const updateWindowSize = async () => {
      try {
        if (minimalMode) {
          const count = holdingCodes.length;
          let rows = 1;
          let width = 120;
          let height = 30;

          if (count > 0) {
            let currentLineWidth = 0;
            const maxLineWidth = 310; // 360 - 左右 padding 12 - 按钮及安全距离 38 = 310
            if (showMinimalTotal) {
              currentLineWidth += 100;
            }
            holdingCodes.forEach((_, index) => {
              const itemWidth = 115;
              const gap = index === 0 && !showMinimalTotal ? 0 : 8;
              if (currentLineWidth + gap + itemWidth > maxLineWidth) {
                rows += 1;
                currentLineWidth = itemWidth;
              } else {
                currentLineWidth += gap + itemWidth;
              }
            });
          }

          if (rows > 1) {
            width = 360;
          } else {
            const baseWidth = showMinimalTotal ? 125 : 55;
            width = count > 0 ? baseWidth + count * 115 : 120;
          }
          height = rows * 26 + 4;

          await invoke("resize_window", { width, height });
        } else {
          await invoke("resize_window", { width: 380, height: 520 });
        }
      } catch (err) {
        console.warn("调整窗口大小失败（可能不在 Tauri 环境中运行）:", err);
      }
    };

    updateWindowSize();
  }, [minimalMode, holdingCodes.length, showMinimalTotal]);



  // 为了能够在异步/定时器 refreshMarket 内部读取最新的 stockCodes 状态，使用 ref 保存最新的 stockCodes
  const stockCodesRef = useRef<string[]>(stockCodes);
  stockCodesRef.current = stockCodes;

  const refreshMarket = async (codesToFetch?: string[]) => {
    const targets = codesToFetch !== undefined ? codesToFetch : stockCodesRef.current;
    setStatus("刷新中");
    try {
      const result = await invoke<MarketSnapshot>("fetch_market_snapshot", {
        stockCodes: targets,
      });
      setSnapshot(result);
      setStatus("在线");
    } catch (error) {
      setStatus(`更新失败: ${String(error)}`);
      invoke("log_message", {
        level: "ERROR",
        message: `前端刷新行情失败: ${String(error)}`,
      }).catch(console.error);
    }
  };

  // 挂载后进行首次行情加载
  useEffect(() => {
    refreshMarket(stockCodes);
  }, []);

  // 定时器：每 15 秒刷新一次
  useEffect(() => {
    const timer = setInterval(() => {
      refreshMarket();
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  const handleStockFormSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const code = inputValue.trim();
    if (!code || stockCodes.includes(code)) {
      setInputValue("");
      return;
    }

    const nextCodes = [...stockCodes, code];
    setStockCodes(nextCodes);
    saveStockCodes(nextCodes);
    setInputValue("");
    refreshMarket(nextCodes);
  };

  const handleDeleteCode = (code: string) => {
    const nextCodes = stockCodes.filter((c) => c !== code);
    setStockCodes(nextCodes);
    saveStockCodes(nextCodes);
    refreshMarket(nextCodes);
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) {
      return;
    }

    const newStockCodes = Array.from(stockCodes);
    const [reorderedItem] = newStockCodes.splice(result.source.index, 1);
    newStockCodes.splice(result.destination.index, 0, reorderedItem);

    setStockCodes(newStockCodes);
    saveStockCodes(newStockCodes);

    // 重新对当前内存中的行情快照排序，防止等待接口请求导致的界面闪烁
    if (snapshot) {
      const newQuotes = Array.from(snapshot.quotes);
      const [reorderedQuote] = newQuotes.splice(result.source.index, 1);
      newQuotes.splice(result.destination.index, 0, reorderedQuote);
      setSnapshot({
        ...snapshot,
        quotes: newQuotes,
      });
    }
  };

  const formatTime = (unixStr: string | undefined) => {
    if (!unixStr) return "--:--:--";
    const date = new Date(Number(unixStr) * 1000);
    return date.toLocaleTimeString("zh-CN", { hour12: false });
  };

  const toggleMinimalMode = () => {
    const nextMode = !minimalMode;
    setMinimalMode(nextMode);
    saveMinimalMode(nextMode);
  };

  const handleDrag = (e: React.MouseEvent) => {
    if (e.button === 0) {
      const target = e.target as HTMLElement;
      if (
        !target.closest(".header-actions") &&
        !target.closest("button") &&
        !target.closest("input")
      ) {
        invoke("start_dragging").catch((err) =>
          console.error("拖动窗口失败:", err)
        );
      }
    }
  };

  const handleMinimalDrag = (e: React.MouseEvent) => {
    if (e.button === 0) {
      const target = e.target as HTMLElement;
      if (!target.closest(".minimal-back-btn") && !target.closest("button")) {
        invoke("start_dragging").catch((err) =>
          console.error("拖动窗口失败:", err)
        );
      }
    }
  };

  const startEditing = (
    symbol: string,
    currentCost?: number,
    currentQty?: number,
    customName?: string
  ) => {
    setEditingSymbol(symbol);
    setEditCost(currentCost !== undefined ? String(currentCost) : "");
    setEditQty(currentQty !== undefined ? String(currentQty) : "");
    setEditCustomName(customName || "");
  };

  const handleSaveHolding = (symbol: string) => {
    const cost = parseFloat(editCost);
    const qty = parseFloat(editQty);
    const name = editCustomName.trim();

    const nextHoldings = { ...holdings };
    const hasValidHolding = !isNaN(cost) && !isNaN(qty) && qty > 0 && cost >= 0;

    if (!name && !hasValidHolding) {
      delete nextHoldings[symbol];
    } else {
      nextHoldings[symbol] = {
        customName: name || undefined,
        cost: hasValidHolding ? cost : undefined,
        qty: hasValidHolding ? qty : undefined,
      };
    }

    setHoldings(nextHoldings);
    saveHoldings(nextHoldings);
    setEditingSymbol(null);
  };

  const handleCancelEditing = () => {
    setEditingSymbol(null);
  };

  // 计算总持仓盈亏
  let totalProfit = 0;
  let totalCost = 0;
  let hasHoldings = false;

  if (snapshot && snapshot.quotes) {
    snapshot.quotes.forEach((quote) => {
      const holding = holdings[quote.symbol];
      if (holding && holding.cost !== undefined && holding.qty !== undefined && quote.price !== null) {
        totalProfit += (quote.price - holding.cost) * holding.qty;
        totalCost += holding.cost * holding.qty;
        hasHoldings = true;
      }
    });
  }

  const totalProfitPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
  const totalProfitDirection = totalProfit >= 0 ? "up" : "down";

  if (minimalMode) {
    return (
      <main
        className="minimal-container"
        data-tauri-drag-region
        onDoubleClick={toggleMinimalMode}
        onContextMenu={(e) => {
          e.preventDefault();
          toggleMinimalMode();
        }}
        onMouseDown={handleMinimalDrag}
      >
        <section className="minimal-quotes" aria-live="polite">
          {holdingCodes.length === 0 ? (
            <span className="minimal-quote" style={{ fontSize: "11px", color: "#7f909e" }}>
              无持仓
            </span>
          ) : (
            <>
              {showMinimalTotal && (
                <>
                  <span className={`minimal-quote ${totalProfitDirection}`}>
                    <b>共</b>
                    <span>
                      {totalProfit >= 0 ? "+" : ""}
                      {amountFormatter.format(totalProfit)}
                      <small style={{ fontSize: "9px", marginLeft: "2px", opacity: 0.8 }}>
                        ({totalProfit >= 0 ? "+" : ""}{formatter.format(totalProfitPercent)}%)
                      </small>
                    </span>
                  </span>
                  {holdingCodes.length > 0 && (
                    <span style={{ color: "rgba(255, 255, 255, 0.15)", fontSize: "11px", margin: "0 2px" }}>|</span>
                  )}
                </>
              )}

              {holdingCodes.map((code) => {
                const quote = snapshot?.quotes.find((q) => q.symbol === code) || {
                  symbol: code,
                  name: code,
                  price: null,
                  change: null,
                  change_percent: null,
                  open: null,
                  high: null,
                  low: null,
                  volume: null,
                  quote_time: "",
                };
                const holding = holdings[code];
                const displayName = holding?.customName || quote.name;
                let profit: number | null = null;
                let profitPercent: number | null = null;
                if (holding && holding.cost !== undefined && holding.qty !== undefined && quote.price !== null) {
                  profit = (quote.price - holding.cost) * holding.qty;
                  profitPercent = ((quote.price - holding.cost) / holding.cost) * 100;
                }
                const direction =
                  profit === null ? "flat" : profit >= 0 ? "up" : "down";

                return (
                  <span key={code} className={`minimal-quote ${direction}`}>
                    <b>{getMinimalLabel(displayName, code)}</b>
                    <span>
                      {profit === null
                        ? "--"
                        : `${profit > 0 ? "+" : ""}${amountFormatter.format(profit)}`}
                      {profitPercent !== null && (
                        <small style={{ fontSize: "9px", marginLeft: "2px", opacity: 0.8 }}>
                          ({profitPercent > 0 ? "+" : ""}{formatter.format(profitPercent)}%)
                        </small>
                      )}
                    </span>
                  </span>
                );
              })}
            </>
          )}
        </section>
        <button
          type="button"
          className="minimal-back-btn"
          onClick={(e) => {
            e.stopPropagation();
            toggleMinimalMode();
          }}
          title="切回普通模式"
        >
          ↩
        </button>
      </main>
    );
  }

  return (
    <main
      className="overlay"
      onClick={() => setContextMenu(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu(null);
      }}
    >
      <header
        data-tauri-drag-region
        onMouseDown={handleDrag}
        title="按住可拖动窗口"
      >
        <div>
          <p>小白鲨</p>
        </div>
        <div className="header-actions">
          <div id="status">{status}</div>
          <button type="button" className="mode-toggle" onClick={toggleMinimalMode}>
            极简
          </button>
        </div>
      </header>
      <form onSubmit={handleStockFormSubmit} style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
        <input
          id="stock-code"
          name="stock-code"
          autoComplete="off"
          inputMode="numeric"
          placeholder="输入股票代码"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          style={{
            minWidth: 0,
            flex: 1,
            padding: "8px 10px",
            border: "1px solid rgba(255, 255, 255, 0.16)",
            borderRadius: "8px",
            background: "rgba(255, 255, 255, 0.1)",
            color: "inherit",
            outline: "none",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "8px 12px",
            border: 0,
            borderRadius: "8px",
            background: "#88d7ef",
            color: "#0d1218",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          添加
        </button>
      </form>

      {hasHoldings && (
        <section
          style={{
            marginTop: "12px",
            padding: "10px 14px",
            background: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "10px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: "12px", color: "#7f909e" }}>总持仓盈亏</span>
          <strong
            className={totalProfitDirection}
            style={{
              fontSize: "14px",
              fontWeight: 800,
            }}
          >
            {totalProfit >= 0 ? "+" : ""}
            {amountFormatter.format(totalProfit)}
            <span style={{ fontSize: "11px", marginLeft: "6px", fontWeight: 600 }}>
              ({totalProfit >= 0 ? "+" : ""}
              {formatter.format(totalProfitPercent)}%)
            </span>
          </strong>
        </section>
      )}

      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="quotes-list">
          {(provided) => (
            <section
              id="quotes"
              aria-live="polite"
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {stockCodes.length === 0 ? (
                <div className="quote">输入股票代码后添加到行情列表</div>
              ) : (
                stockCodes.map((code, index) => {
                  const quote = snapshot?.quotes.find((q) => q.symbol === code) || {
                    symbol: code,
                    name: "加载中...",
                    price: null,
                    change: null,
                    change_percent: null,
                    open: null,
                    high: null,
                    low: null,
                    volume: null,
                    quote_time: "",
                  };
                  const direction =
                    quote.change === null ? "flat" : quote.change >= 0 ? "up" : "down";
                  const isEditing = editingSymbol === quote.symbol;
                  const holding = holdings[quote.symbol];
                  const displayName = holding?.customName || quote.name;

                  let profit: number | null = null;
                  let profitPercent: number | null = null;
                  if (holding && holding.cost !== undefined && holding.qty !== undefined && quote.price !== null) {
                    profit = (quote.price - holding.cost) * holding.qty;
                    profitPercent = ((quote.price - holding.cost) / holding.cost) * 100;
                  }
                  const profitDirection =
                    profit === null ? "flat" : profit >= 0 ? "up" : "down";

                  return (
                    <Draggable
                      key={quote.symbol}
                      draggableId={quote.symbol}
                      index={index}
                    >
                      {(provided, dndSnapshot) => {
                        if (isEditing) {
                          return (
                            <article
                              className={`quote editing ${
                                dndSnapshot.isDragging ? "dragging" : ""
                              }`}
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              style={{
                                ...provided.draggableProps.style,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "stretch",
                                gap: "6px",
                              }}
                            >
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleSaveHolding(quote.symbol);
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                                style={{
                                  display: "flex",
                                  width: "100%",
                                  alignItems: "center",
                                  gap: "6px",
                                  fontSize: "11px",
                                }}
                              >
                                <div style={{ display: "flex", flex: 1, gap: "4px" }}>
                                  <input
                                    type="text"
                                    placeholder="备注名"
                                    value={editCustomName}
                                    onChange={(e) => setEditCustomName(e.target.value)}
                                    style={{
                                      width: "60px",
                                      padding: "3px 6px",
                                      background: "rgba(255,255,255,0.06)",
                                      border: "1px solid rgba(255,255,255,0.12)",
                                      borderRadius: "4px",
                                      color: "#fff",
                                      outline: "none",
                                    }}
                                  />
                                  <input
                                    type="number"
                                    step="any"
                                    placeholder="成本价"
                                    value={editCost}
                                    onChange={(e) => setEditCost(e.target.value)}
                                    style={{
                                      width: "60px",
                                      padding: "3px 6px",
                                      background: "rgba(255,255,255,0.06)",
                                      border: "1px solid rgba(255,255,255,0.12)",
                                      borderRadius: "4px",
                                      color: "#fff",
                                      outline: "none",
                                    }}
                                  />
                                  <input
                                    type="number"
                                    placeholder="持股数"
                                    value={editQty}
                                    onChange={(e) => setEditQty(e.target.value)}
                                    style={{
                                      width: "55px",
                                      padding: "3px 6px",
                                      background: "rgba(255,255,255,0.06)",
                                      border: "1px solid rgba(255,255,255,0.12)",
                                      borderRadius: "4px",
                                      color: "#fff",
                                      outline: "none",
                                    }}
                                  />
                                </div>
                                <button
                                  type="submit"
                                  style={{
                                    padding: "3px 6px",
                                    border: 0,
                                    borderRadius: "4px",
                                    background: "#88d7ef",
                                    color: "#0d1218",
                                    fontWeight: 700,
                                    cursor: "pointer",
                                  }}
                                >
                                  保存
                                </button>
                                <button
                                  type="button"
                                  onClick={handleCancelEditing}
                                  style={{
                                    padding: "3px 6px",
                                    border: 0,
                                    borderRadius: "4px",
                                    background: "rgba(255,255,255,0.1)",
                                    color: "#c9d5df",
                                    cursor: "pointer",
                                  }}
                                >
                                  取消
                                </button>
                              </form>
                            </article>
                          );
                        }

                        return (
                          <article
                            className={`quote ${direction} ${
                              dndSnapshot.isDragging ? "dragging" : ""
                            }`}
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setContextMenu({
                                symbol: quote.symbol,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                            style={{
                              ...provided.draggableProps.style,
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "stretch",
                              justifyContent: "center",
                              gap: "4px",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                width: "100%",
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                            >
                              <div>
                                <span className="symbol">{quote.symbol}</span>
                                <span className="name">{displayName}</span>
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                }}
                              >
                                <div
                                  className="price-block"
                                  style={{ textAlign: "right" }}
                                >
                                  <strong>{formatPrice(quote.price, quote.symbol)}</strong>
                                  <span style={{ marginLeft: "6px" }}>
                                    {formatChange(quote.change_percent, "%")}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {holding && profit !== null && profitPercent !== null && (
                              <div
                                style={{
                                  display: "flex",
                                  width: "100%",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  paddingTop: "4px",
                                  borderTop: "1px dashed rgba(255,255,255,0.06)",
                                  fontSize: "11px",
                                  color: "#7f909e",
                                }}
                              >
                                <div>
                                  <span>
                                    持股:{" "}
                                    <b style={{ color: "#dce6ee" }}>
                                      {holding.qty}
                                    </b>
                                  </span>
                                  <span style={{ marginLeft: "8px" }}>
                                    成本:{" "}
                                    <b style={{ color: "#dce6ee" }}>
                                      {formatPrice(holding.cost ?? null, quote.symbol)}
                                    </b>
                                  </span>
                                </div>
                                <div
                                  className={profitDirection}
                                  style={{ fontWeight: 700 }}
                                >
                                  盈亏:{" "}
                                  {`${profit > 0 ? "+" : ""}${amountFormatter.format(
                                    profit
                                  )} (${
                                    profitPercent > 0 ? "+" : ""
                                  }${formatter.format(profitPercent)}%)`}
                                </div>
                              </div>
                            )}
                          </article>
                        );
                      }}
                    </Draggable>
                  );
                })
              )}
              {provided.placeholder}
            </section>
          )}
        </Droppable>
      </DragDropContext>

      <footer>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span id="source">{snapshot?.source || "东方财富网页行情"}</span>
          <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#7f909e", cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={showMinimalTotal}
              onChange={(e) => {
                setShowMinimalTotal(e.target.checked);
                saveShowMinimalTotal(e.target.checked);
              }}
              style={{ margin: 0, cursor: "pointer" }}
            />
            显示极简共计
          </label>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() =>
              invoke("open_log_file").catch((err) =>
                alert("无法打开日志: " + err)
              )
            }
            style={{
              padding: "4px 8px",
              background: "rgba(255, 255, 255, 0.1)",
              border: 0,
              borderRadius: "6px",
              color: "#c9d5df",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            日志
          </button>
          <span>
            更新 <b id="updated-at">{formatTime(snapshot?.updated_at)}</b>
          </span>
        </div>
      </footer>

      {contextMenu && (
        <div
          style={{
            position: "fixed",
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            background: "rgba(20, 26, 33, 0.98)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            borderRadius: "8px",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
            zIndex: 100,
            display: "flex",
            flexDirection: "column",
            minWidth: "90px",
            padding: "4px",
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              const h = holdings[contextMenu.symbol];
              startEditing(contextMenu.symbol, h?.cost, h?.qty, h?.customName);
              setContextMenu(null);
            }}
            style={{
              padding: "6px 10px",
              background: "transparent",
              border: 0,
              color: "#eef3f8",
              fontSize: "11px",
              textAlign: "left",
              cursor: "pointer",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
            className="menu-item"
          >
            <span>✏️</span> 编辑持仓
          </button>
          <button
            type="button"
            onClick={() => {
              handleDeleteCode(contextMenu.symbol);
              setContextMenu(null);
            }}
            style={{
              padding: "6px 10px",
              background: "transparent",
              border: 0,
              color: "#ff7f7a",
              fontSize: "11px",
              textAlign: "left",
              cursor: "pointer",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
            className="menu-item"
          >
            <span>❌</span> 删除股票
          </button>
        </div>
      )}
    </main>
  );
}

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
