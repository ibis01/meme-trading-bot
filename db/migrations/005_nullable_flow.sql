-- smartWalletNetFlowUsd is not exposed by Birdeye. Rule 30 says don't fake it.
ALTER TABLE price_bars
  ALTER COLUMN smart_wallet_net_flow_usd DROP NOT NULL;
