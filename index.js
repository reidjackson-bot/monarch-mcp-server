process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const PORT = process.env.PORT || 10000;
const MONARCH_TOKEN = process.env.MONARCH_TOKEN;
const MONARCH_API = "https://api.monarchmoney.com/graphql";

async function monarchQuery(query, variables = {}) {
  const res = await fetch(MONARCH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Token ${MONARCH_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Monarch API error ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

function createServer() {
  const server = new McpServer({ name: "monarch-money", version: "1.0.0" });

  server.tool("monarch_get_accounts", "Get all linked financial accounts with current balances.", {}, async () => {
    try {
      const data = await monarchQuery(`
        query {
          accounts {
            id displayName currentBalance displayBalance
            type { name display }
            subtype { name display }
            institution { name }
            includeInNetWorth isAsset isHidden
          }
        }
      `);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_transactions", "Get transactions with filtering.", {
    limit: z.number().optional().default(100),
    offset: z.number().optional().default(0),
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    search: z.string().optional().default(""),
  }, async ({ limit, offset, start_date, end_date, search }) => {
    try {
      const filters = { limit, offset, search };
      if (start_date) filters.startDate = start_date;
      if (end_date) filters.endDate = end_date;
      const data = await monarchQuery(`
        query GetTransactions($filters: TransactionFilterInput) {
          allTransactions(filters: $filters) {
            results {
              id date amount
              merchant { name }
              category { name }
              account { displayName }
              pending notes isRecurring
            }
            totalCount
          }
        }
      `, { filters });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_budgets", "Get budget data by category.", {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
  }, async ({ start_date, end_date }) => {
    try {
      const data = await monarchQuery(`
        query GetBudgets($startDate: Date, $endDate: Date) {
          budgetData(startDate: $startDate, endDate: $endDate) {
            totalIncome totalExpenses totalSavings
            budgetCategories {
              category { name }
              budgetAmount { amount }
              actualAmount
              remainingAmount
            }
          }
        }
      `, { startDate: start_date, endDate: end_date });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_net_worth", "Get net worth snapshots and trends.", {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
  }, async ({ start_date, end_date }) => {
    try {
      const data = await monarchQuery(`
        query GetNetWorth($startDate: Date, $endDate: Date) {
          aggregateSnapshots(startDate: $startDate, endDate: $endDate) {
            date assetsBalance liabilitiesBalance
          }
          accounts {
            id displayName currentBalance
            type { name display }
            isAsset includeInNetWorth
            institution { name }
          }
        }
      `, { startDate: start_date, endDate: end_date });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_categories", "Get all transaction categories.", {}, async () => {
    try {
      const data = await monarchQuery(`
        query { categories { id name group { name } } }
      `);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_holdings", "Get investment holdings for an account.", {
    account_id: z.string().describe("Account ID from monarch_get_accounts"),
  }, async ({ account_id }) => {
    try {
      const data = await monarchQuery(`
        query GetHoldings($accountId: UUID!) {
          portfolio(accountId: $accountId) {
            holdings {
              name ticker quantity value costBasis
            }
          }
        }
      `, { accountId: account_id });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_refresh_accounts", "Trigger fresh sync from all banks.", {}, async () => {
    try {
      const data = await monarchQuery(`
        mutation { requestAccountsRefresh { success } }
      `);
      return { content: [{ type: "text", text: JSON.stringify({ status: "refresh_requested", data }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null }));
});

app.delete("/mcp", (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Not supported." }, id: null }));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MONARCH MCP] Running on port ${PORT}`);
  console.log(`[MONARCH MCP] Token: ${MONARCH_TOKEN ? "configured" : "MISSING"}`);
});
