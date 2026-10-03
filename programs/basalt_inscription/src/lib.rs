use anchor_lang::prelude::*;

declare_id!("GRJr1pdTLEqpWRiSvvWCLZViKqxD7tiMYpPUEjUUgZin");

#[program]
pub mod basalt_inscription {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, service_fee_wallet: Pubkey, service_fee_bps: u16, min_cu_price: u64, min_cu_limit: u32) -> Result<()> {
        validate_config(service_fee_bps, min_cu_price, min_cu_limit)?;
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.service_fee_wallet = service_fee_wallet;
        cfg.service_fee_bps = service_fee_bps;
        cfg.min_cu_price = min_cu_price;
        cfg.min_cu_limit = min_cu_limit;
        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, service_fee_wallet: Option<Pubkey>, service_fee_bps: Option<u16>, min_cu_price: Option<u64>, min_cu_limit: Option<u32>) -> Result<()> {
        require!(ctx.accounts.authority.key() == ctx.accounts.config.authority, ErrorCode::Unauthorized);
        validate_config(service_fee_bps.unwrap_or(ctx.accounts.config.service_fee_bps), min_cu_price.unwrap_or(ctx.accounts.config.min_cu_price), min_cu_limit.unwrap_or(ctx.accounts.config.min_cu_limit))?;
        if let Some(w) = service_fee_wallet { ctx.accounts.config.service_fee_wallet = w; }
        if let Some(b) = service_fee_bps { ctx.accounts.config.service_fee_bps = b; }
        if let Some(p) = min_cu_price { ctx.accounts.config.min_cu_price = p; }
        if let Some(l) = min_cu_limit { ctx.accounts.config.min_cu_limit = l; }
        Ok(())
    }

    pub fn inscribe(ctx: Context<Inscribe>, memo_hash: [u8; 32], cu_limit: u32, cu_price_micro_lamports: u64) -> Result<()> {
        // 校验 ComputeBudget 参数下限
        require!(cu_limit >= ctx.accounts.config.min_cu_limit, ErrorCode::CuLimitTooLow);
        require!(cu_price_micro_lamports >= ctx.accounts.config.min_cu_price, ErrorCode::CuPriceTooLow);

        // 校验交易中实际设置的 ComputeBudget 指令是否与入参一致
        {
            let ix_ai = &ctx.accounts.instructions_sysvar.to_account_info();
            let data = ix_ai.try_borrow_data()?;
            let current_index = anchor_lang::solana_program::sysvar::instructions::load_current_index(&data) as usize;
            let mut found_limit: Option<u32> = None;
            let mut found_price: Option<u64> = None;

            // 使用已知的 Compute Budget 程序地址（避免依赖 solana_program::compute_budget 模块）
            let cb_program_id: Pubkey = anchor_lang::solana_program::pubkey!(
                "ComputeBudget111111111111111111111111111111"
            );
            // 扫描当前指令之前的所有顶层指令（ComputeBudget 通常位于本程序调用之前）
            for i in 0..current_index {
                if let Ok(ix) = anchor_lang::solana_program::sysvar::instructions::load_instruction_at(i, &data) {
                    if ix.program_id == cb_program_id {
                        if !ix.data.is_empty() {
                            match ix.data[0] {
                                2 => { // SetComputeUnitLimit(u32)
                                    if ix.data.len() == 1 + 4 {
                                        let mut buf = [0u8; 4];
                                        buf.copy_from_slice(&ix.data[1..5]);
                                        let v = u32::from_le_bytes(buf);
                                        found_limit = Some(v);
                                    }
                                }
                                3 => { // SetComputeUnitPrice(u64)
                                    if ix.data.len() == 1 + 8 {
                                        let mut buf = [0u8; 8];
                                        buf.copy_from_slice(&ix.data[1..9]);
                                        let v = u64::from_le_bytes(buf);
                                        found_price = Some(v);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }

            require!(found_limit.is_some(), ErrorCode::MissingComputeBudgetLimit);
            require!(found_price.is_some(), ErrorCode::MissingComputeBudgetPrice);

            let actual_limit = found_limit.unwrap();
            let actual_price = found_price.unwrap();

            require!(actual_limit == cu_limit, ErrorCode::ComputeBudgetLimitMismatch);
            require!(actual_price == cu_price_micro_lamports, ErrorCode::ComputeBudgetPriceMismatch);
        }

        let sysvar = ctx.accounts.instructions_sysvar.to_account_info();
        let current = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(&sysvar)? as usize;
        let memo = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(current + 1, &sysvar)?;
        require!(memo.program_id == anchor_lang::solana_program::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), ErrorCode::InvalidMemo);
        require!(anchor_lang::solana_program::hash::hash(&memo.data).to_bytes() == memo_hash, ErrorCode::InvalidMemo);

        // 计算优先费与服务费（只对优先费抽成）
        let (priority_fee_lamports, service_fee_lamports) = calculate_fees(cu_limit, cu_price_micro_lamports, ctx.accounts.config.service_fee_bps)?;

        // 从签名者转账服务费到平台钱包
        if service_fee_lamports > 0 {
            let ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.config.service_fee_wallet,
                service_fee_lamports,
            );
            anchor_lang::solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.service_fee_wallet.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // 触发事件，供索引和前端使用
        emit!(InscribedEvent {
            payer: ctx.accounts.payer.key(),
            memo_hash,
            cu_limit,
            cu_price_micro_lamports,
            priority_fee_paid: priority_fee_lamports,
            service_fee_charged: service_fee_lamports,
            ts: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"config"],
        bump,
        space = 8 + Config::SIZE,
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::BasaltInscription>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ ErrorCode::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Inscribe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: 转账目的账户由配置给出
    #[account(mut, address = config.service_fee_wallet)]
    pub service_fee_wallet: UncheckedAccount<'info>,
    /// CHECK: Instructions sysvar to read tx instructions 
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub service_fee_wallet: Pubkey,
    pub service_fee_bps: u16,
    pub min_cu_price: u64,
    pub min_cu_limit: u32,
}

impl Config {
    pub const SIZE: usize = 32 + 32 + 2 + 8 + 4;
}

#[event]
pub struct InscribedEvent {
    pub payer: Pubkey,
    pub memo_hash: [u8; 32],
    pub cu_limit: u32,
    pub cu_price_micro_lamports: u64,
    pub priority_fee_paid: u64,
    pub service_fee_charged: u64,
    pub ts: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("invalid configuration")]
    InvalidConfig,
    #[msg("fee overflow")]
    FeeOverflow,
    #[msg("memo instruction/hash mismatch")]
    InvalidMemo,
    #[msg("unauthorized")] 
    Unauthorized,
    #[msg("cu_limit too low")] 
    CuLimitTooLow,
    #[msg("cu_price too low")] 
    CuPriceTooLow,
    #[msg("missing SetComputeUnitLimit before program call")] 
    MissingComputeBudgetLimit,
    #[msg("missing SetComputeUnitPrice before program call")] 
    MissingComputeBudgetPrice,
    #[msg("compute unit limit mismatch with transaction")] 
    ComputeBudgetLimitMismatch,
    #[msg("compute unit price mismatch with transaction")] 
    ComputeBudgetPriceMismatch,
}
fn validate_config(bps: u16, price: u64, limit: u32) -> Result<()> {
    require!(bps <= 10_000 && limit > 0 && limit <= 1_400_000 && price <= 1_000_000_000, ErrorCode::InvalidConfig);
    Ok(())
}

fn calculate_fees(limit: u32, price: u64, bps: u16) -> Result<(u64, u64)> {
    let priority = (limit as u128 * price as u128 + 999_999) / 1_000_000;
    let service = (priority * bps as u128 + 9_999) / 10_000;
    require!(priority <= u64::MAX as u128 && service <= u64::MAX as u128, ErrorCode::FeeOverflow);
    Ok((priority as u64, service as u64))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rounds_up_and_uses_wide_arithmetic() {
        assert_eq!(calculate_fees(1, 1, 50).unwrap(), (1, 1));
        assert_eq!(calculate_fees(200_000, 50_000, 50).unwrap(), (10_000, 50));
        assert!(calculate_fees(u32::MAX, u64::MAX, 10_000).is_err());
    }
    #[test]
    fn rejects_invalid_config() {
        assert!(validate_config(10_001, 1, 1).is_err());
        assert!(validate_config(50, 1, 1_400_001).is_err());
        assert!(validate_config(50, 1, 0).is_err());
        assert!(validate_config(50, 20_000, 120_000).is_ok());
    }
}
