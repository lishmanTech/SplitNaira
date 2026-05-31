import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WalletValidatorService {
  constructor(
    private readonly configService: ConfigService,
  ) {}

  validate() {
    const issuer =
      this.configService.get<string>(
        'STELLAR_ISSUER_PUBLIC_KEY',
      );

    const distributor =
      this.configService.get<string>(
        'STELLAR_DISTRIBUTOR_PUBLIC_KEY',
      );

    const stellarRegex = /^G[A-Z0-9]{55}$/;

    return {
      valid:
        stellarRegex.test(issuer ?? '') &&
        stellarRegex.test(distributor ?? ''),
    };
  }
}