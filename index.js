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

// ============================================================
// GraphQL Queries — aligned with Monarch's actual schema
// (reference: hammem/monarchmoney Python library + community fork)
// ============================================================

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

// FIX #1: limit/offset are arguments on the `results` field, NOT on `allTransactions`.
// The query signature includes $offset, $limit, $orderBy as top-level variables,
// but they are passed to `results(...)` inside `allTransactions`.
const GET_TRANSACTIONS = `
  query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
    allTransactions(filters: $filters) {
      totalCount
      results(offset: $offset, limit: $limit, orderBy: $orderBy) {
        id
        amount
        pending
        date
        hideFromReports
        notes
        isRecurring
        merchant { name }
        category { id name }
        account { id displayName }
        tags { id name }
      }
    }
  }
`;

const GET_TRANSACTION_CATEGORIES = `
  query GetCategories {
    categories {
      id
      name
      group { id name type }
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

// FIX #2: Cashflow uses `aggregates(filters:)` with TransactionFilterInput, NOT `cashflow(startDate, endDate)`.
// Dates go inside $filters.startDate / $filters.endDate.
const GET_CASHFLOW_SUMMARY = `
  query Web_GetCashFlowPage($filters: TransactionFilterInput) {
    summary: aggregates(filters: $filters, fillEmptyValues: true) {
      summary {
        sumIncome
        sumExpense
        savings
        savingsRate
      }
    }
  }
`;

// Extended cashflow with category breakdown
const GET_CASHFLOW_BY_CATEGORY = `
  query Web_GetCashFlowPage($filters: TransactionFilterInput) {
    byCategory: aggregates(filters: $filters, groupBy: ["category"]) {
      groupBy {
        category {
          id
          name
          group {
            id
            type
            name
          }
        }
      }
      summary {
        sumIncome
        sumExpense
        savings
        savingsRate
      }
    }
  }
`;

// FIX #3: Budgets use `budgetData(startMonth:, endMonth:)` with Date! scalars, NOT `budgets(startDate, endDate)`.
const GET_BUDGETS = `
  query GetJointPlanningData($startDate: Date!, $endDate: Date!) {
    budgetData(startMonth: $startDate, endMonth: $endDate) {
      monthlyAmountsByCategory {
        category {
          id
          name
        }
        monthlyAmounts {
          month
          plannedCashFlowAmount
          plannedSetAsideAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
          rolloverType
        }
      }
      monthlyAmountsByCategoryGroup {
        categoryGroup {
          id
          name
        }
        monthlyAmounts {
          month
          plannedCashFlowAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
          rolloverType
        }
      }
      monthlyAmountsForFlexExpense {
        budgetVariability
        monthlyAmounts {
          month
          plannedCashFlowAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
          rolloverType
        }
      }
      totalsByMonth {
        month
        totalIncome {
          plannedAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
        }
        totalExpenses {
          plannedAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
        }
        totalFixedExpenses {
          plannedAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
        }
        totalNonMonthlyExpenses {
          plannedAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
        }
        totalFlexibleExpenses {
          plannedAmount
          actualAmount
          remainingAmount
          previousMonthRolloverAmount
        }
      }
    }
    categoryGroups {
      id
      name
      order
      groupLevelBudgetingEnabled
      budgetVariability
      categories {
        id
        name
        order
        budgetVariability
      }
      type
    }
  }
`;

// FIX #4: Holdings use `portfolio(input: PortfolioInput)` with nested `aggregateHoldings`,
// NOT `accountHoldings(accountId)`.
const GET_HOLDINGS = `
  query Web_GetHoldings($input: PortfolioInput) {
    portfolio(input: $input) {
      aggregateHoldings {
        edges {
          node {
            id
            quantity
            basis
            totalValue
            securityPriceChangeDollars
            securityPriceChangePercent
            lastSyncedAt
            holdings {
              id
              type
              typeDisplay
              name
              ticker
              closingPrice
              isManual
              closingPriceUpdatedAt
            }
            security {
              id
              name
              type
              ticker
              typeDisplay
              currentPrice
              currentPriceUpdatedAt
              closingPrice
              closingPriceUpdatedAt
              oneDayChangePercent
              oneDayChangeDollars
            }
          }
        }
      }
    }
  }
`;

// Transaction aggregates/summary
const GET_TRANSACTION_SUMMARY = `
  query GetTransactionsPage($filters: TransactionFilterInput) {
    aggregates(filters: $filters) {
      summary {
        avg
        count
        max
        maxExpense
        sum
        sumIncome
        sumExpense
        first
        last
      }
    }
  }
`;

// Recurring transactions
const GET_RECURRING_TRANSACTIONS = `
  query GetRecurringTransactions {
    recurringTransactions {
      id
      title
      amount
      frequency
      isActive
      merchant { name }
      category { id name }
      account { id displayName }
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
    version: '3.0.0',
  });

  // ─── Accounts ───
  server.tool(
    'monarch_get_accounts',
    'Get all financial accounts linked to Monarch Money with current balances, types, and institution info.',
    {},
    async () => {
      const data = await monarchQuery(GET_ACCOUNTS);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Transactions (with working pagination) ───
  server.tool(
    'monarch_get_transactions',
    'Get transactions with optional filters: date range, account, search text, category, and limit. Supports pagination via limit/offset.',
    {
      startDate: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
      accountIds: z.array(z.string()).optional().describe('Array of account IDs to filter by'),
      search: z.string().optional().describe('Search text to filter by merchant name or notes'),
      categoryIds: z.array(z.string()).optional().describe('Array of category IDs to filter by'),
      limit: z.number().optional().describe('Max transactions to return (default 100, max 500)'),
      offset: z.number().optional().describe('Offset for pagination (default 0)'),
    },
    async ({ startDate, endDate, accountIds, search, categoryIds, limit, offset }) => {
      // Build the filters object (goes into TransactionFilterInput)
      const filters = {};
      if (startDate) filters.startDate = startDate;
      if (endDate) filters.endDate = endDate;
      if (search !== undefined && search !== '') filters.search = search;
      if (accountIds && accountIds.length > 0) filters.accounts = accountIds;
      if (categoryIds && categoryIds.length > 0) filters.categories = categoryIds;

      // limit/offset/orderBy are top-level variables, passed to results() field
      const variables = {
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        limit: limit ?? 100,
        offset: offset ?? 0,
        orderBy: 'date',
      };

      const data = await monarchQuery(GET_TRANSACTIONS, variables, 'GetTransactionsList');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Transaction Summary (aggregates) ───
  server.tool(
    'monarch_get_transaction_summary',
    'Get transaction aggregates/summary (count, sum, avg, income, expense totals) for a date range.',
    {
      startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
      accountIds: z.array(z.string()).optional().describe('Array of account IDs to filter by'),
      search: z.string().optional().describe('Search text filter'),
    },
    async ({ startDate, endDate, accountIds, search }) => {
      const filters = {};
      if (startDate) filters.startDate = startDate;
      if (endDate) filters.endDate = endDate;
      if (search) filters.search = search;
      if (accountIds && accountIds.length > 0) filters.accounts = accountIds;

      const data = await monarchQuery(GET_TRANSACTION_SUMMARY, { filters });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Balances (historical snapshots) ───
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

  // ─── Cashflow Summary ───
  server.tool(
    'monarch_get_cashflow',
    'Get cashflow summary (income, expenses, savings, savings rate) for a date range.',
    {
      startDate: z.string().describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().describe('End date (YYYY-MM-DD)'),
    },
    async ({ startDate, endDate }) => {
      const filters = {
        startDate,
        endDate,
        search: '',
        categories: [],
        accounts: [],
        tags: [],
      };
      const data = await monarchQuery(GET_CASHFLOW_SUMMARY, { filters }, 'Web_GetCashFlowPage');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Cashflow by Category ───
  server.tool(
    'monarch_get_cashflow_by_category',
    'Get cashflow broken down by category (income and expenses per category) for a date range.',
    {
      startDate: z.string().describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().describe('End date (YYYY-MM-DD)'),
    },
    async ({ startDate, endDate }) => {
      const filters = {
        startDate,
        endDate,
        search: '',
        categories: [],
        accounts: [],
        tags: [],
      };
      const data = await monarchQuery(GET_CASHFLOW_BY_CATEGORY, { filters }, 'Web_GetCashFlowPage');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Budgets ───
  server.tool(
    'monarch_get_budgets',
    'Get budget data including planned vs actual amounts by category for a date range.',
    {
      startDate: z.string().optional().describe('Start date (YYYY-MM-DD), defaults to current month start'),
      endDate: z.string().optional().describe('End date (YYYY-MM-DD), defaults to current month end'),
    },
    async ({ startDate, endDate }) => {
      // Default to current month if not specified
      const now = new Date();
      const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

      const variables = {
        startDate: startDate || defaultStart,
        endDate: endDate || defaultEnd,
      };
      const data = await monarchQuery(GET_BUDGETS, variables, 'GetJointPlanningData');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Holdings ───
  server.tool(
    'monarch_get_holdings',
    'Get investment holdings for a specific brokerage account.',
    {
      accountId: z.string().describe('The account ID to get holdings for'),
    },
    async ({ accountId }) => {
      const today = new Date().toISOString().split('T')[0];
      const variables = {
        input: {
          accountIds: [accountId],
          startDate: today,
          endDate: today,
          includeHiddenHoldings: true,
        },
      };
      const data = await monarchQuery(GET_HOLDINGS, variables, 'Web_GetHoldings');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Categories ───
  server.tool(
    'monarch_get_categories',
    'Get all transaction categories and their groups.',
    {},
    async () => {
      const data = await monarchQuery(GET_TRANSACTION_CATEGORIES);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── Recurring Transactions ───
  server.tool(
    'monarch_get_recurring',
    'Get recurring/subscription transactions.',
    {},
    async () => {
      try {
        const data = await monarchQuery(GET_RECURRING_TRANSACTIONS);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Recurring transactions query failed: ' + err.message }] };
      }
    }
  );

  // ─── Refresh Accounts ───
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
  res.json({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString() });
});
app.get('/api/accounts', (_req, res) => { monarchQuery(GET_ACCOUNTS).then(d => res.json(d)).catch(e => res.status(500).json({error: String(e)})); });

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
  console.log('[Monarch MCP] v3.0.0 on port ' + PORT);
});
