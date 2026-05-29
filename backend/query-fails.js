const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const res = await pool.query(`
      SELECT wallet, COUNT(*) as fail_count
      FROM distribution_payments 
      WHERE status = 'failed'
      GROUP BY wallet
      ORDER BY fail_count DESC
    `);
    
    console.log('=== FAILED WALLETS ===');
    console.log('Total unique wallets failing:', res.rows.length);
    for (const row of res.rows) {
      console.log(row.wallet + ' | fails: ' + row.fail_count);
    }
    
    const errors = await pool.query(`
      SELECT DISTINCT substring(error_message, 1, 100) as err 
      FROM distribution_payments WHERE status = 'failed'
    `);
    console.log('\n=== DISTINCT ERRORS ===');
    for (const e of errors.rows) console.log(e.err);
    
    const stats = await pool.query(`
      SELECT status, COUNT(*) as cnt FROM distribution_payments GROUP BY status
    `);
    console.log('\n=== PAYMENT STATS ===');
    for (const s of stats.rows) console.log(s.status + ': ' + s.cnt);

    // Check if the same wallets fail every time
    const consistentFails = await pool.query(`
      SELECT dp.wallet, 
             COUNT(*) FILTER (WHERE dp.status = 'failed') as fails,
             COUNT(*) FILTER (WHERE dp.status = 'confirmed') as successes
      FROM distribution_payments dp
      WHERE dp.wallet IN (
        SELECT wallet FROM distribution_payments WHERE status = 'failed' GROUP BY wallet
      )
      GROUP BY dp.wallet
      ORDER BY fails DESC
    `);
    console.log('\n=== FAIL vs SUCCESS per wallet ===');
    for (const r of consistentFails.rows) {
      console.log(r.wallet.slice(0,12) + '... | fails: ' + r.fails + ' | successes: ' + r.successes);
    }

  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();
