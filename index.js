process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import {
  getAccounts,
  getTransactions,
  getBudgets,
  getAggregateSnapshots,
  getAccountHoldings,
  getRecentAccountBalances,
  getTransactionCategories,
  requestAccountsRefreshAndWait,
} from "monarch-money-api";

const PORT = process.env.PORT || 8080;

function createServer() {
  const server = new McpServer({ name: "monarch-money", version: "1.0.0" });

  server.tool("monarch_get_accounts", "Get all linked financial accounts with current balances.", {}, async () => {
    try {
      const accounts = await getAccounts();
      return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
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
    category_ids: z.array(z.string()).optional().default([]),
    account_ids: z.array(z.string()).optional().default([]),
    is_recurring: z.boolean().optional(),
  }, async ({ limit, offset, start_date, end_date, search, category_ids, account_ids, is_recurring }) => {
    try {
      const params = { limit, offset, search, categoryIds: category_ids, accountIds: account_ids };
      if (start_date) params.startDate = start_date;
      if (end_date) params.endDate = end_date;
      if (is_recurring !== undefined) params.isRecurring = is_recurring;
      const transactions = await getTransactions(params);
      return { content: [{ type: "text", text: JSON.stringify(transactions, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_budgets", "Get budget data by category.", {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
  }, async ({ start_date, end_date }) => {
    try {
      const budgets = await getBudgets(start_date, end_date);
      return { content: [{ type: "text", text: JSON.stringify(budgets, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_net_worth", "Get net worth snapshots and trends.", {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
    end_date: z.string().optional().describe("YYYY-MM-DD"),
    account_type: z.string().optional(),
  }, async ({ start_date, end_date, account_type }) => {
    try {
      const snapshots = await getAggregateSnapshots(start_date, end_date, account_type);
      return { content: [{ type: "text", text: JSON.stringify(snapshots, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_holdings", "Get investment holdings for an account.", {
    account_id: z.string().describe("Account ID from monarch_get_accounts"),
  }, async ({ account_id }) => {
    try {
      const holdings = await getAccountHoldings(account_id);
      return { content: [{ type: "text", text: JSON.stringify(holdings, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_balances", "Get recent balance history.", {
    start_date: z.string().optional().describe("YYYY-MM-DD"),
  }, async ({ start_date }) => {
    try {
      const balances = await getRecentAccountBalances(start_date);
      return { content: [{ type: "text", text: JSON.stringify(balances, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_get_categories", "Get all transaction categories.", {}, async () => {
    try {
      const categories = await getTransactionCategories();
      return { content: [{ type: "text", text: JSON.stringify(categories, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  });

  server.tool("monarch_refresh_accounts", "Trigger fresh sync from all banks.", {}, async () => {
    try {
      const result = await requestAccountsRefreshAndWait();
      return { content: [{ type: "text", text: JSON.stringify({ status: "complete", result }, null, 2) }] };
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
  console.log(`[MONARCH MCP] Token: ${process.env.MONARCH_TOKEN ? "configured" : "MISSING"}`);
});
