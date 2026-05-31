import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EnvironmentValidatorService } from './environment-validator.service';
import { StellarNetworkValidatorService } from './stellar-network-validator.service';
import { WalletValidatorService } from './wallet-validator.service';

@Injectable()
export class MainnetReadinessService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly envValidator: EnvironmentValidatorService,
    private readonly networkValidator: StellarNetworkValidatorService,
    private readonly walletValidator: WalletValidatorService,
  ) {}

  async getReadiness() {
    const checks = [];

    const env = this.envValidator.validate();

    checks.push({
      name: 'environment',
      status: env.valid ? 'pass' : 'fail',
    });

    const network =
      this.networkValidator.validate();

    checks.push({
      name: 'stellar-network',
      status: network.valid ? 'pass' : 'fail',
    });

    const wallet =
      this.walletValidator.validate();

    checks.push({
      name: 'wallet-config',
      status: wallet.valid ? 'pass' : 'fail',
    });

    try {
      await this.dataSource.query('SELECT 1');

      checks.push({
        name: 'database',
        status: 'pass',
      });
    } catch {
      checks.push({
        name: 'database',
        status: 'fail',
      });
    }

    return {
      ready: checks.every(
        (c) => c.status === 'pass',
      ),
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}