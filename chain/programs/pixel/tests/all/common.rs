//! LiteSVM harness for the `pixel` program. Loads target/deploy/pixel.so (run `anchor build` first).
#![allow(dead_code)]

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use base64::Engine;
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use pixel::{constants::*, error::PixelError, state::*};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub const SOL_USD_FEED: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];
pub const T0: i64 = 1_800_000_000;
pub const SOL_PRICE: i64 = 15_000_000_000; // $150.00000000, expo -8
pub const EXPO: i32 = -8;
pub const DECIMALS: u8 = 6;
pub const SUPPLY: u64 = 1_000_000_000 * 1_000_000;
pub const CURVE_VSOL: u64 = 30_000_000_000;
pub const CURVE_VTOK: u64 = 1_073_000_000_000_000;
pub const SPL_TOKEN: Pubkey = anchor_spl::token::ID;
pub const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;

#[derive(Clone, Copy, PartialEq)]
pub enum Source {
    Curve,
    Pool,
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub keeper: Keypair,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub price_update: Pubkey,
    pub curve: Pubkey,
    pub pool: Pubkey,
    pub pool_base_vault: Pubkey,
    pub pool_quote_vault: Pubkey,
    pub source: Source,
    /// EMA seed passed to initialize (default: honest curve price).
    pub initial_ema: u128,
}

pub fn pid() -> Pubkey {
    pixel::id()
}
pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pid()).0
}
pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
pub fn canvas_pda() -> Pubkey {
    pda(&[CANVAS_SEED])
}
pub fn vault_pda() -> Pubkey {
    pda(&[BUYBACK_VAULT_SEED])
}
pub fn auction_pda() -> Pubkey {
    pda(&[AUCTION_SEED])
}
pub fn ad_pda(x: u8, y: u8) -> Pubkey {
    pda(&[AD_SEED, &(y as u16 * 100 + x as u16).to_le_bytes()])
}
pub fn auction_ad_pda() -> Pubkey {
    pda(&[AD_AUCTION_SEED])
}

pub fn anchor_err(e: PixelError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

// ------------------------------------------------------------- raw SPL layouts
pub fn pack_mint(supply: u64, decimals: u8, authority: Option<Pubkey>) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    if let Some(a) = authority {
        d[0..4].copy_from_slice(&1u32.to_le_bytes());
        d[4..36].copy_from_slice(a.as_ref());
    }
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}

pub fn pack_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

pub fn read_mint_supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let a = svm.get_account(mint).unwrap();
    u64::from_le_bytes(a.data[36..44].try_into().unwrap())
}
pub fn read_token_amount(svm: &LiteSVM, ta: &Pubkey) -> u64 {
    let a = svm.get_account(ta).unwrap();
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

// ------------------------------------------------------------- pump layouts (from public IDLs)
pub fn pack_curve(vsol: u64, vtok: u64, complete: bool, quote_mint: Pubkey) -> Vec<u8> {
    let mut d = vec![0u8; 8 + 8 * 5 + 1 + 32 + 1 + 1 + 32 + 8 + 1 + 1 + 8 + 8 + 1 + 8 + 8 + 8];
    d[0..8].copy_from_slice(&PUMP_BONDING_CURVE_DISCRIMINATOR);
    d[8..16].copy_from_slice(&vtok.to_le_bytes());
    d[16..24].copy_from_slice(&vsol.to_le_bytes());
    d[24..32].copy_from_slice(&(vtok / 2).to_le_bytes());
    d[32..40].copy_from_slice(&(vsol / 2).to_le_bytes());
    d[40..48].copy_from_slice(&SUPPLY.to_le_bytes());
    d[48] = complete as u8;
    d[83..115].copy_from_slice(quote_mint.as_ref());
    d
}

pub fn pack_pool(base_mint: &Pubkey, base_vault: &Pubkey, quote_vault: &Pubkey, vqr: i128) -> Vec<u8> {
    let mut d = vec![0u8; 8 + 1 + 2 + 32 * 6 + 8 + 32 + 1 + 1 + 16 + 8 + 1 + 1 + 8 + 8];
    d[0..8].copy_from_slice(&PUMP_AMM_POOL_DISCRIMINATOR);
    d[43..75].copy_from_slice(base_mint.as_ref());
    d[75..107].copy_from_slice(WSOL_MINT.as_ref());
    d[139..171].copy_from_slice(base_vault.as_ref());
    d[171..203].copy_from_slice(quote_vault.as_ref());
    d[245..261].copy_from_slice(&vqr.to_le_bytes());
    d
}

impl Env {
    pub fn new(token_program: Pubkey, source: Source) -> Env {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/pixel.so"));
        svm.add_program(pid(), bytes).unwrap();
        let admin = Keypair::new();
        let keeper = Keypair::new();
        let treasury = Pubkey::new_unique();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&keeper.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&treasury, 1_000_000_000).unwrap();

        // Make `admin` the program's upgrade authority (litesvm deploys with authority None).
        let pd_addr = Pubkey::find_program_address(&[pid().as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID).0;
        let mut pd = svm.get_account(&pd_addr).unwrap();
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(admin.pubkey().as_ref());
        svm.set_account(pd_addr, pd).unwrap();

        let mut env = Env {
            svm,
            admin,
            keeper,
            treasury,
            mint: Pubkey::new_unique(),
            token_program,
            price_update: Pubkey::new_unique(),
            curve: Pubkey::default(),
            pool: Pubkey::new_unique(),
            pool_base_vault: Pubkey::new_unique(),
            pool_quote_vault: Pubkey::new_unique(),
            source,
            initial_ema: ref_price_q(CURVE_VSOL, CURVE_VTOK),
        };
        env.curve = Pubkey::find_program_address(&[b"bonding-curve", env.mint.as_ref()], &PUMP_PROGRAM_ID).0;
        // canonical PumpSwap migration pool + its ATAs (what validate_price_source requires)
        let pool_auth = Pubkey::find_program_address(&[b"pool-authority", env.mint.as_ref()], &PUMP_PROGRAM_ID).0;
        env.pool = Pubkey::find_program_address(
            &[b"pool", &0u16.to_le_bytes(), pool_auth.as_ref(), env.mint.as_ref(), WSOL_MINT.as_ref()],
            &PUMP_AMM_PROGRAM_ID,
        )
        .0;
        env.pool_base_vault = Pubkey::find_program_address(&[env.pool.as_ref(), token_program.as_ref(), env.mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM_ID).0;
        env.pool_quote_vault = Pubkey::find_program_address(&[env.pool.as_ref(), SPL_TOKEN.as_ref(), WSOL_MINT.as_ref()], &ASSOCIATED_TOKEN_PROGRAM_ID).0;
        env.set_time(T0, 1_000);
        env.set_raw(env.mint, pack_mint(SUPPLY, DECIMALS, None), token_program);
        env.set_sol_price(SOL_PRICE, 10_000_000, T0);
        env.set_curve(CURVE_VSOL, CURVE_VTOK);
        env.set_pool(CURVE_VSOL, CURVE_VTOK, 0);
        env
    }

    /// new() + initialize (EMA seeded at the honest price) + full warm-up.
    pub fn ready(token_program: Pubkey, source: Source) -> Env {
        let mut env = Env::new(token_program, source);
        let admin = env.admin.insecure_clone();
        env.send(&[env.ix_initialize(&admin.pubkey())], &[&admin]).unwrap();
        env.warm_up();
        env
    }

    /// EMA_WARMUP_CRANKS cranks, 67 s apart (9 gaps = 603 s >= EMA_WARMUP_SECS), then 1 s into a new slot.
    pub fn warm_up(&mut self) {
        let kp = self.keeper.insecure_clone();
        for _ in 0..EMA_WARMUP_CRANKS {
            self.warp(67);
            self.refresh_price();
            ok(self.send(&[self.ix_crank()], &[&kp]));
        }
        self.warp(1);
        self.refresh_price();
    }

    pub fn ix_set_paused(&self, admin: &Pubkey, paused: bool) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::SetPaused { paused }.data(),
            pixel::accounts::SetPaused { admin: *admin, config: config_pda(), auction: auction_pda() }.to_account_metas(None),
        )
    }

    pub fn ix_set_price_source(&self, admin: &Pubkey, price_source: PriceSource, initial_ema: u128) -> Instruction {
        self.ix_admin(admin, pixel::instruction::SetPriceSource { price_source, initial_ema_price_sol: initial_ema })
    }

    pub fn set_raw(&mut self, addr: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len()).max(1);
        self.svm
            .set_account(addr, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
    pub fn set_time(&mut self, ts: i64, slot: u64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = ts;
        c.slot = slot;
        self.svm.set_sysvar(&c);
    }
    /// Advance wall-clock and slot (2.5 slots/s).
    pub fn warp(&mut self, secs: i64) {
        let c: Clock = self.svm.get_sysvar();
        let slot = c.slot + (secs as u64 * 5 / 2).max(1);
        self.set_time(c.unix_timestamp + secs, slot);
    }

    pub fn set_price_update(&mut self, price: i64, conf: u64, publish_time: i64, feed: [u8; 32], level: VerificationLevel) {
        let pu = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: level,
            price_message: PriceFeedMessage {
                feed_id: feed,
                price,
                conf,
                exponent: EXPO,
                publish_time,
                prev_publish_time: publish_time - 1,
                ema_price: price,
                ema_conf: conf,
            },
            posted_slot: 1,
        };
        let mut data = Vec::new();
        pu.try_serialize(&mut data).unwrap();
        let addr = self.price_update;
        self.set_raw(addr, data, pyth_solana_receiver_sdk::ID);
    }
    pub fn set_sol_price(&mut self, price: i64, conf: u64, publish_time: i64) {
        self.set_price_update(price, conf, publish_time, SOL_USD_FEED, VerificationLevel::Full);
    }
    /// Fresh price at the current clock.
    pub fn refresh_price(&mut self) {
        let now = self.now();
        self.set_sol_price(SOL_PRICE, 10_000_000, now);
    }

    pub fn set_curve(&mut self, vsol: u64, vtok: u64) {
        let addr = self.curve;
        self.set_raw(addr, pack_curve(vsol, vtok, false, Pubkey::default()), PUMP_PROGRAM_ID);
    }
    pub fn set_pool(&mut self, quote: u64, base: u64, vqr: i128) {
        let (pool, bv, qv, mint, tp) = (self.pool, self.pool_base_vault, self.pool_quote_vault, self.mint, self.token_program);
        self.set_raw(pool, pack_pool(&mint, &bv, &qv, vqr), PUMP_AMM_PROGRAM_ID);
        let pool_auth = Pubkey::new_unique();
        self.set_raw(bv, pack_token_account(&mint, &pool_auth, base), tp);
        self.set_raw(qv, pack_token_account(&WSOL_MINT, &pool_auth, quote), SPL_TOKEN);
    }
    /// Sets the token spot in whichever source is active.
    pub fn set_spot(&mut self, vsol: u64, vtok: u64) {
        match self.source {
            Source::Curve => self.set_curve(vsol, vtok),
            Source::Pool => self.set_pool(vsol, vtok, 0),
        }
    }

    pub fn price_source(&self) -> PriceSource {
        match self.source {
            Source::Curve => PriceSource::BondingCurve { curve: self.curve },
            Source::Pool => PriceSource::Pool {
                pool: self.pool,
                base_vault: self.pool_base_vault,
                quote_vault: self.pool_quote_vault,
            },
        }
    }
    /// (price_source, base_vault, quote_vault) account keys for ixs.
    pub fn price_accounts(&self) -> (Pubkey, Option<Pubkey>, Option<Pubkey>) {
        match self.source {
            Source::Curve => (self.curve, None, None),
            Source::Pool => (self.pool, Some(self.pool_base_vault), Some(self.pool_quote_vault)),
        }
    }

    pub fn new_user(&mut self, lamports: u64, tokens: u64) -> (Keypair, Pubkey) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), lamports).unwrap();
        let ta = Pubkey::new_unique();
        let (mint, tp) = (self.mint, self.token_program);
        self.set_raw(ta, pack_token_account(&mint, &kp.pubkey(), tokens), tp);
        if tokens > 0 {
            // keep supply consistent with balances held outside the "rest of the world"
            let supply = read_mint_supply(&self.svm, &mint);
            assert!(supply >= tokens);
        }
        (kp, ta)
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = signers[0].pubkey();
        let mut cu = vec![2u8];
        cu.extend_from_slice(&1_400_000u32.to_le_bytes());
        let mut all = vec![Instruction::new_with_bytes(
            anchor_lang::prelude::pubkey!("ComputeBudget111111111111111111111111111111"),
            &cu,
            vec![],
        )];
        all.extend_from_slice(ixs);
        let msg = Message::new_with_blockhash(&all, Some(&payer), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let r = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        r
    }

    pub fn config(&self) -> Config {
        self.load(&config_pda())
    }
    pub fn canvas(&self) -> Canvas {
        self.load(&canvas_pda())
    }
    pub fn ad_at(&self, x: u8, y: u8) -> Ad {
        self.load(&ad_pda(x, y))
    }
    pub fn auction(&self) -> Auction {
        self.load(&auction_pda())
    }
    pub fn load<T: AccountDeserialize>(&self, k: &Pubkey) -> T {
        let a = self.svm.get_account(k).expect("account missing");
        T::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    pub fn lamports(&self, k: &Pubkey) -> u64 {
        self.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
    }

    // ------------------------------------------------------------- ix builders
    pub fn ix_initialize(&self, admin: &Pubkey) -> Instruction {
        let pd = Pubkey::find_program_address(&[pid().as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID).0;
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::Initialize {
                params: pixel::InitializeParams {
                    treasury: self.treasury,
                    keeper: self.keeper.pubkey(),
                    pyth_feed_id: SOL_USD_FEED,
                    price_source: self.price_source(),
                    max_price_age_secs: 60,
                    buyback_cap_lamports_per_hour: 5_000_000_000,
                    buyback_max_slippage_bps: 1_500,
                    initial_token_ema_price_sol: self.initial_ema,
                    token_blocks_cap_per_hour: DEFAULT_TOKEN_BLOCKS_CAP_PER_HOUR,
                },
            }
            .data(),
            pixel::accounts::Initialize {
                admin: *admin,
                config: config_pda(),
                canvas: canvas_pda(),
                buyback_vault: vault_pda(),
                token_mint: self.mint,
                token_program: self.token_program,
                program: pid(),
                program_data: pd,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_crank(&self) -> Instruction {
        let (ps, bv, qv) = self.price_accounts();
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::CrankTokenPrice {}.data(),
            pixel::accounts::CrankTokenPrice {
                config: config_pda(),
                price_source: ps,
                pool_base_vault: bv,
                pool_quote_vault: qv,
            }
            .to_account_metas(None),
        )
    }

    pub fn next_ad_id(&self) -> u32 {
        self.canvas().next_ad_id
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_buy_sol(&self, buyer: &Pubkey, x: u8, y: u8, w: u8, h: u8, max_lamports: u64) -> Instruction {
        self.ix_buy_sol_full(buyer, x, y, w, h, "Hello", "https://example.com", "ar://abc", max_lamports, self.price_update)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_buy_sol_full(
        &self,
        buyer: &Pubkey,
        x: u8,
        y: u8,
        w: u8,
        h: u8,
        title: &str,
        link: &str,
        uri: &str,
        max_lamports: u64,
        price_update: Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::BuyWithSol {
                x,
                y,
                w,
                h,
                title: title.into(),
                link: link.into(),
                image_uri: uri.into(),
                image_sha256: [7u8; 32],
                max_lamports,
            }
            .data(),
            pixel::accounts::BuyWithSol {
                buyer: *buyer,
                config: config_pda(),
                canvas: canvas_pda(),
                ad: ad_pda(x, y),
                treasury: self.treasury,
                buyback_vault: vault_pda(),
                price_update,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_buy_token(&self, buyer: &Pubkey, ta: &Pubkey, x: u8, y: u8, w: u8, h: u8, max_tokens: u64) -> Instruction {
        let (ps, bv, qv) = self.price_accounts();
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::BuyWithToken {
                x,
                y,
                w,
                h,
                title: "Tok".into(),
                link: "https://example.com".into(),
                image_uri: "ar://abc".into(),
                image_sha256: [9u8; 32],
                max_tokens,
            }
            .data(),
            pixel::accounts::BuyWithToken {
                buyer: *buyer,
                config: config_pda(),
                canvas: canvas_pda(),
                ad: ad_pda(x, y),
                token_mint: self.mint,
                buyer_token_account: *ta,
                price_update: self.price_update,
                price_source: ps,
                pool_base_vault: bv,
                pool_quote_vault: qv,
                token_program: self.token_program,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_admin<T: InstructionData>(&self, admin: &Pubkey, data: T) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &data.data(),
            pixel::accounts::AdminOnly { admin: *admin, config: config_pda() }.to_account_metas(None),
        )
    }

    pub fn ix_release(&self, keeper: &Pubkey, lamports: u64) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::ReleaseBuyback { lamports }.data(),
            pixel::accounts::ReleaseBuyback {
                keeper: *keeper,
                config: config_pda(),
                buyback_vault: vault_pda(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_record(&self, keeper: &Pubkey, keeper_ta: &Pubkey, lamports_spent: u64, tokens_burned: u64) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::RecordBuybackBurn { lamports_spent, tokens_burned }.data(),
            pixel::accounts::RecordBuybackBurn {
                keeper: *keeper,
                config: config_pda(),
                canvas: canvas_pda(),
                buyback_vault: vault_pda(),
                token_mint: self.mint,
                keeper_token_account: *keeper_ta,
                token_program: self.token_program,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_update_ad(&self, owner: &Pubkey, ad: Pubkey, link: &str) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::UpdateAd {
                title: "Updated".into(),
                link: link.into(),
                image_uri: "ar://new".into(),
                image_sha256: [1u8; 32],
            }
            .data(),
            pixel::accounts::UpdateAd { owner: *owner, ad }.to_account_metas(None),
        )
    }

    pub fn ix_transfer_ad(&self, owner: &Pubkey, ad: Pubkey, new_owner: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::TransferAd { new_owner }.data(),
            pixel::accounts::TransferAd { owner: *owner, ad }.to_account_metas(None),
        )
    }

    pub fn ix_start_auction(&self, payer: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::StartFinalAuction {}.data(),
            pixel::accounts::StartFinalAuction {
                payer: *payer,
                config: config_pda(),
                canvas: canvas_pda(),
                auction: auction_pda(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_bid(&self, bidder: &Pubkey, prev: Option<Pubkey>, lamports: u64) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::BidFinalAuction { lamports }.data(),
            pixel::accounts::BidFinalAuction {
                bidder: *bidder,
                config: config_pda(),
                auction: auction_pda(),
                previous_bidder: prev,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_restart_auction(&self) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::RestartFinalAuction {}.data(),
            pixel::accounts::RestartFinalAuction { config: config_pda(), auction: auction_pda() }.to_account_metas(None),
        )
    }

    pub fn ix_settle(&self, payer: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pid(),
            &pixel::instruction::SettleFinalAuction {}.data(),
            pixel::accounts::SettleFinalAuction {
                payer: *payer,
                config: config_pda(),
                canvas: canvas_pda(),
                auction: auction_pda(),
                ad: auction_ad_pda(),
                buyback_vault: vault_pda(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
}

// ------------------------------------------------------------- assertions / events
pub fn custom_code(r: &Result<TransactionMetadata, FailedTransactionMetadata>) -> Option<u32> {
    use solana_transaction_error::TransactionError;
    use solana_instruction::error::InstructionError;
    match r {
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        },
        Ok(_) => None,
    }
}

#[track_caller]
pub fn assert_err(r: Result<TransactionMetadata, FailedTransactionMetadata>, e: PixelError) {
    let want = anchor_err(e);
    match &r {
        Ok(m) => panic!("expected error {want} ({e:?}), tx succeeded. logs: {:#?}", m.logs),
        Err(f) => assert_eq!(
            custom_code(&r),
            Some(want),
            "expected {e:?} ({want}), got {:?}\nlogs: {:#?}",
            f.err,
            f.meta.logs
        ),
    }
}

#[track_caller]
pub fn assert_code(r: Result<TransactionMetadata, FailedTransactionMetadata>, code: u32) {
    match &r {
        Ok(m) => panic!("expected error code {code}, tx succeeded. logs: {:#?}", m.logs),
        Err(f) => assert_eq!(custom_code(&r), Some(code), "got {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

#[track_caller]
pub fn ok(r: Result<TransactionMetadata, FailedTransactionMetadata>) -> TransactionMetadata {
    match r {
        Ok(m) => m,
        Err(f) => panic!("tx failed: {:?}\nlogs: {:#?}", f.err, f.meta.logs),
    }
}

pub fn events<T: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    let mut out = vec![];
    for l in &meta.logs {
        if let Some(b64) = l.strip_prefix("Program data: ") {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
            if bytes.starts_with(T::DISCRIMINATOR) {
                out.push(T::deserialize(&mut &bytes[T::DISCRIMINATOR.len()..]).unwrap());
            }
        }
    }
    out
}

// ------------------------------------------------------------- reference math (independent of program code)
/// lamports = ceil(usd_micro * 1e11 / price) for expo -8
pub fn ref_lamports(usd_micro: u64, price: i64) -> u64 {
    let num = usd_micro as u128 * 100_000_000_000u128;
    num.div_ceil(price as u128) as u64
}
pub fn ref_price_q(vsol: u64, vtok: u64) -> u128 {
    vsol as u128 * 1_000_000_000_000_000_000u128 / vtok as u128
}
pub fn ref_tokens(blocks: u64, price: i64, price_q: u128) -> u64 {
    let usd = blocks * 100_000_000 * 9 / 10;
    let lamports = ref_lamports(usd, price) as u128;
    (lamports * 1_000_000_000_000_000_000u128).div_ceil(price_q) as u64
}
