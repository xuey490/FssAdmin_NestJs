import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../../../common/entities/base';

@Entity('sa_system_user_tenant', { comment: '用户租户关联表' })
export class SysUserTenantEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'id', comment: '主键' })
  id: number;

  @Column({ type: 'bigint', name: 'user_id', comment: '用户ID' })
  userId: number;

  @Column({ type: 'bigint', name: 'tenant_id', comment: '租户ID' })
  tenantId: number;

  @Column({ type: 'tinyint', name: 'is_super', default: 0, comment: '是否超级管理员' })
  isSuper: number;

  @Column({ type: 'tinyint', name: 'is_default', default: 0, comment: '是否默认' })
  isDefault: number;

  /** 加入租户时间：关联记录建立时间（列表展示与排序使用） */
  @Column({ type: 'datetime', name: 'join_time', nullable: true, comment: '加入租户时间' })
  joinTime: Date;
}
