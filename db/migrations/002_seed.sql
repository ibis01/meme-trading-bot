-- Rule 21: single-row portfolio state, immutable identity
INSERT INTO portfolio_state (id, open_positions, equity_sol)
VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;
