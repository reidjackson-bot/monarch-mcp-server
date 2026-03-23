import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = parseInt(process.env.PORT || '3000', 10);
const MONARCH_TOKEN = process.env.MONARCH_TOKEN;
const MONARCH_API_URL = 'https://api.monarch.com/graphql';

if (!MONARCH_TOKEN) {
  console.error('Missing MONARCH_TOKEN environment variable');
  process.exit(1);
}

async function monarchQuery(query, variables = {}, operationName = undefined) {
  const body = { query };
  if (variables && Object.keys(variables).length > 0) body.variables = variables;
  if (operationName) body.operationName = operationName;

  const response = await fetch(MONARCH_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token ' + MONARCH_TOKEN,
      'Client-Platform': 'web',
      'Origin': 'https://app.monarch.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error('Monarch API error (' + response.status + '): ' + text.substring(0, 500));
  }

  const data = await response.json();
  if (data.errors) {
    throw new Error('GraphQL errors: ' + JSON.stringify(data.errors));
  }
  return data;
}

const GET_ACCOUNTS = `
  query GetAccounts {
    accounts {
      id
      displayName
      currentBalance
      displayBalance
      type { name display }
      subtype { name display }
      institution { name }
      includeInNetWorth
      isAsset
      isHidden
    }
  }
`;

const GET_TRANSACTIONS_SIMPLE = `
  query {
    allTransactions {
      totalCount
      results {
        id
        date
        amount
        merchant { name }
        category { name }
        account { displayName id }
        pending
        notes
        isRecurring
      }
    }
  }
`;

const GET_TRANSACTIONS_FILTERED = `
  query GetTransactions($filters: TransactionFilterInput) {
    allTransactions(filters: $filters) {
      totalCount
      results {
        id
        date
        amount
        merchant { name }
        category { name }
        account { displayName id }
        pending
        notes
        isRecurring
      }
    }
  }
`;

const GET_TRANSACTION_CATEGORIES = `
  query GetCategories {
    categories {
      id
      name
      group { name }
    }
  }
`;

const GET_ACCOUNT_SNAPSHOTS = `
  query GetAccountSnapshots($startDate: String!, $endDate: String!, $accountIds: [UUID!]) {
    accountSnapshotsByType(startDate: $startDate, endDate: $endDate, accountIds: $accountIds) {
      accountType
      month
      balance
    }
  }
`;

const GET_CASHFLOW_SUMMARY = `
  query GetCashflowSummary($startDate: String!, $endDate: String!) {
    cashflow(startDate: $startDate, endDate: $endDate) {
      summary {
        sumIncome
        sumExpense
        savings
        savingsRate
      }
    }
  }
`;

const GET_BUDGETS = `
  query GetBudgets($startDate: String, $endDate: String) {
    budgets(startDate: $startDate, endDate: $endDate) {
      budgetItem {
        id
        category { name }
        budgetAmount {
          amount
        }
        currentAmount
      }
    }
  }
`;

const GET_HOLDINGS = `
  query GetAccountHoldings($accountId: UUID!) {
    accountHoldings(accountId: $accountId) {
      id
      name
      ticker
      closingPrice
      quantity
      value
      costBasis
    }
  }
`;

const REFRESH_ACCOUNTS = `
  mutation RequestAccountsRefresh {
    requestAccountsRefresh {
      success
    }
  }
`;

function createServer() {
  const server = new McpServer({
    name: 'monarch-money-mcp',
    version: '2.0.0',
  });

  server.tool(
    'monarch_get_accounts',
    'Get all financial accounts linked to Monarch Money with current balances, types, and institution info.',
    {},
    async () => {
      const data = await monarchQuery(GET_ACCOUNTS);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'monarch_get_transactions',
    'Get transactions with optional filters: date range, account, search text, category, and limit.',
    {
      startDate: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
      accountIds: z.array(z.string()).optional().describe('Array of account IDs to filter by'),
      search: z.string().optional().describe('Search text to filter by merchant name or notes'),
      categoryIds: z.array(z.string()).optional().describe('Array of category IDs to filter by'),
      limit: z.number().optional().describe('Max transactions to return (default 30, max 500)'),
      offset: z.number().optional().describe('Offset for pagination (default 0)'),
    },
    async ({ startDate, endDate, accountIds, search, categoryIds, limit, offset }) => {
      const hasFilters = startDate || endDate || accountIds || search || categoryIds || limit || offset;

      if (!hasFilters) {
        const data = await monarchQuery(GET_TRANSACTIONS_SIMPLE);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      const filters = {};
      if (startDate) filters.startDate = startDate;
      if (endDate) filters.endDate = endDate;
      if (accountIds && accountIds.length > 0) filters.accounts = accountIds;
      if (search) filters.search = search;
      if (categoryIds && categoryIds.length > 0) filters.categories = categoryIds;

      try {
        const variables = {
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        };
        const data = await monarchQuery(GET_TRANSACTIONS_FILTERED, variables, 'GetTransactions');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const data = await monarchQuery(GET_TRANSACTIONS_SIMPLE);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) + '\n\nNote: Filtering was not applied due to API error. Showing default results.' }] };
      }
    }
  );

  server.tool(
    'monarch_get_balances',
    'Get historical balance snapshots by account type over a date range.',
    {
      startDate: z.string().describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().describe('End date (YYYY-MM-DD)'),
      accountIds: z.array(z.string()).optional().describe('Optional account IDs to filter'),
    },
    async ({ startDate, endDate, accountIds }) => {
      const variables = { startDate, endDate };
      if (accountIds && accountIds.length > 0) variables.accountIds = accountIds;
      const data = await monarchQuery(GET_ACCOUNT_SNAPSHOTS, variables);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'monarch_get_cashflow',
    'Get cashflow summary (income, expenses, savings, savings rate) for a date range.',
    {
      startDate: z.string().describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().describe('End date (YYYY-MM-DD)'),
    },
    async ({ startDate, endDate }) => {
      const data = await monarchQuery(GET_CASHFLOW_SUMMARY, { startDate, endDate });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'monarch_get_budgets',
    'Get budget data including planned vs actual amounts by category.',
    {
      startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
    },
    async ({ startDate, endDate }) => {
      const variables = {};
      if (startDate) variables.startDate = startDate;
      if (endDate) variables.endDate = endDate;
      const data = await monarchQuery(GET_BUDGETS, variables);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'monarch_get_holdings',
    'Get investment holdings for a specific brokerage account.',
    {
      accountId: z.string().describe('The account ID to get holdings for'),
    },
    async ({ accountId }) => {
      const data = await monarchQuery(GET_HOLDINGS, { accountId });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'monarch_get_categories',
    'Get all transaction categories and their groups.',
    {},
    async () => {
      const data = await monarchQuery(GET_TRANSACTION_CATEGORIES);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    'monarch_refresh_accounts',
    'Trigger a sync/refresh of all linked financial accounts.',
    {},
    async () => {
      const data = await monarchQuery(REFRESH_ACCOUNTS);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Use POST.' },
    id: null,
  }));
});

app.delete('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Not supported.' },
    id: null,
  }));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('[Monarch MCP] v2.0.0 on port ' + PORT);
});
