import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { LoggingModule } from './logging/logging.module';
import { HealthModule } from './modules/health/health.module';

import { DemoKitModule } from './modules/demo-kit/demo-kit.module';
import { DemoKitTestModule } from './modules/demo-kit-test/demo-kit-test.module';

import { ApiVerifierModule } from './api-verifier/api-verifier.module';
import { CommonModule } from './module/common/common.module';
import { SystemModule } from './module/system/system.module';
import { MainModule } from './module/main/main.module';
import { UploadModule } from './module/upload/upload.module';
import { MonitorModule } from './module/monitor/monitor.module';
import { ArticleModule } from './module/article/article.module';
import { AiModule } from './module/ai/ai.module';
import { TaixuModule } from './module/taixu/taixu.module';

import { ReadonlyModeGuard } from './common/guards/readonly-mode.guard';
import { JwtAuthGuard } from './common/guards/auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PermissionGuard } from './common/guards/permission.guard';

import { OperlogInterceptor } from './common/interceptor/operlog.interceptor';
import { TenantInterceptor } from './common/interceptor/tenant.interceptor';
import { MemoryMonitorInterceptor } from './common/interceptor/memory-monitor.interceptor';

import { EntityAuditSubscriber } from './common/subscriber/entity-audit.subscriber';
import { TypeOrmAuditBootstrap } from './common/typeorm/typeorm-audit.bootstrap';
import { patchTypeOrmAudit } from './common/typeorm/typeorm-audit.patch';

import { SensitiveWordService } from './common/services/sensitive-word.service';
import { GlobalSecurityInterceptor } from './common/interceptor/global-security.interceptor';

patchTypeOrmAudit();

const nodeEnv = process.env.NODE_ENV ?? 'development';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${nodeEnv}`, '.env'],
      load: [configuration],
      validationSchema: envValidationSchema,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const options: Record<string, any> = {
          type: 'mysql',
          host: config.get('database.host', '127.0.0.1'),
          port: config.get('database.port', 3306),
          username: config.get('database.username', 'root'),
          password: config.get('database.password', ''),
          database: config.get('database.name', 'nestjs'),
          charset: 'utf8',
          autoLoadEntities: true,
          subscribers: [EntityAuditSubscriber],
          synchronize: false,
          logging: config.get('database.logging', false),
        };
        return options as any;
      },
    }),

    ScheduleModule.forRoot(),

    // @golevelup/nestjs-modules：根模块配置一次，子模块用 DemoKitModule.deferred() 复用
    DemoKitModule.forRootAsync(DemoKitModule, {
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        prefix: config.get<string>('app.name', 'nextjs-server'),
        enabled: true,
      }),
    }),

    DatabaseModule,
    RedisModule,
    LoggingModule,
    HealthModule,

    DemoKitTestModule,
    ApiVerifierModule,

    CommonModule,
    SystemModule,
    MainModule,
    UploadModule,
    MonitorModule,
    ArticleModule,
    AiModule,
    TaixuModule,
  ],
  providers: [
    SensitiveWordService,
    { provide: APP_INTERCEPTOR, useClass: GlobalSecurityInterceptor },
    { provide: APP_GUARD, useClass: ReadonlyModeGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: OperlogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MemoryMonitorInterceptor },
    TypeOrmAuditBootstrap,
  ],
})
export class AppModule {}
