import { Repository, In, Not, IsNull, DataSource } from 'typeorm';
import { Injectable, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../../../redis/redis.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import type { Response } from 'express-serve-static-core';
import { getNowDate, generateUUID, uniq, formatDateTime } from '../../../common/utils/index';
import { ExportTable } from '../../../common/utils/export';

import { CacheEnum, StatusEnum, DataScopeEnum } from '../../../common/enum/index';
import { LOGIN_TOKEN_EXPIRESIN, ACCESS_TOKEN_EXPIRESIN, REFRESH_TOKEN_EXPIRESIN, REFRESH_TOKEN_KEY } from '../../../common/constant/index';
import { ResultData } from '../../../common/utils/result';
import { CreateUserDto, UpdateUserDto, ListUserDto, ChangeStatusDto, ResetPwdDto, AllocatedListDto, UpdateProfileDto, UpdatePwdDto, SetHomePageDto } from './dto/index';
import { RegisterDto, LoginDto } from '../../main/dto/index';
import { AuthUserCancelDto, AuthUserCancelAllDto, AuthUserSelectAllDto } from '../role/dto/index';

import { UserEntity } from './entities/sys-user.entity';
import { SysUserPostEntity } from './entities/user-width-post.entity';
import { SysUserRoleEntity } from './entities/user-width-role.entity';
import { SysUserMenuEntity } from './entities/user-menu.entity';
import { SysPostEntity } from '../post/entities/post.entity';
import { SysDeptEntity } from '../dept/entities/dept.entity';
import type { RoleService } from '../role/role.service';
import { DeptService } from '../dept/dept.service';
import type { MenuService } from '../menu/menu.service';

import { ConfigService } from '../config/config.service';
import { SysRoleEntity } from '../role/entities/role.entity';
import { SysMenuEntity } from '../menu/entities/menu.entity';
import { SysUserTenantEntity } from './entities/user-tenant.entity';
import { TenantEntity } from '../tenant/entities/tenant.entity';
import type { UserType } from './dto/user';
import type { ClientInfoDto } from '../../../common/decorators/common.decorator';
import { Cacheable, CacheEvict } from '../../../common/decorators/redis.decorator';
import { Captcha } from '../../../common/decorators/captcha.decorator';
import { getTenantId, applyTenantFilter, appendTenantWhere } from '../../../common/utils/tenant.util';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { AxiosService } from '../../common/axios/axios.service';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(SysDeptEntity)
    private readonly sysDeptEntityRep: Repository<SysDeptEntity>,
    @InjectRepository(SysPostEntity)
    private readonly sysPostEntityRep: Repository<SysPostEntity>,
    @InjectRepository(SysUserPostEntity)
    private readonly sysUserWithPostEntityRep: Repository<SysUserPostEntity>,
    @InjectRepository(SysUserRoleEntity)
    private readonly sysUserWithRoleEntityRep: Repository<SysUserRoleEntity>,
    @InjectRepository(SysUserMenuEntity)
    private readonly sysUserMenuEntityRep: Repository<SysUserMenuEntity>,
    @InjectRepository(SysUserTenantEntity)
    private readonly sysUserTenantEntityRep: Repository<SysUserTenantEntity>,
    @InjectRepository(TenantEntity)
    private readonly tenantEntityRep: Repository<TenantEntity>,
    @Inject(forwardRef(() => require('../role/role.service').RoleService))
    private readonly roleService: RoleService,
    @Inject(DeptService)
    private readonly deptService: DeptService,
    @Inject(forwardRef(() => require('../menu/menu.service').MenuService))
    private readonly menuService: MenuService,
    @Inject(JwtService)
    private readonly jwtService: JwtService,
    @Inject(RedisService)
    private readonly redisService: RedisService,
    @Inject(ConfigService)
    private readonly configService: ConfigService,
    @Inject(AxiosService)
    private readonly axiosService: AxiosService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}
  /**
   * 后台创建用户
   * @param createUserDto
   * @returns
   */
  async create(createUserDto: CreateUserDto) {
    const salt = bcrypt.genSaltSync(10);
    if (createUserDto.password) {
      createUserDto.password = await bcrypt.hashSync(createUserDto.password, salt);
    }

    const tenantId = getTenantId();

    await this.dataSource.transaction(async (manager) => {
      const res = await manager.save(UserEntity, createUserDto);

      const postValues = (createUserDto.post_ids || []).map((id) => ({
        userId: res.id,
        postId: id,
        ...(tenantId ? { tenantId } : {}),
      }));
      if (postValues.length) {
        await manager.insert(SysUserPostEntity, postValues);
      }

      const roleValues = (createUserDto.role_ids || []).map((id) => ({
        userId: res.id,
        roleId: id,
        ...(tenantId ? { tenantId } : {}),
      }));
      if (roleValues.length) {
        await manager.insert(SysUserRoleEntity, roleValues);
      }

      if (tenantId) {
        await manager.save(SysUserTenantEntity, {
          userId: res.id,
          tenantId,
          isDefault: 0,
          joinTime: new Date(),
        });
      }
    });

    return ResultData.ok();
  }

  /**
   * 格式化用户行数据
   * @param user 用户实体（含可选部门信息）
   * @returns 格式化后的用户行对象
   */
  private formatUserRow(user: UserEntity & { dept?: SysDeptEntity }) {
    const dept = user.dept;
    return {
      id: Number(user.id),
      username: user.username,
      realname: user.realname,
      phone: user.phone,
      email: user.email,
      avatar: user.avatar,
      gender: user.gender,
      status: user.status,
      dashboard: user.dashboard,
      dept_id: user.deptId ? Number(user.deptId) : null,
      login_time: formatDateTime(user.loginTime),
      create_time: formatDateTime(user.createTime),
      update_time: formatDateTime(user.updateTime),
      dept: dept ? { id: Number(dept.id), name: dept.name } : null,
    };
  }

  /**
   * 用户列表
   * @param query
   * @returns
   */
  async findAll(query: ListUserDto, user: UserType['user']) {
    const entity = this.userRepo.createQueryBuilder('user');
    entity.where('user.deleteTime IS NULL');

    const tenantId = getTenantId();
    if (tenantId) {
      const tenantUserIds = await this.getTenantUserIds(tenantId);
      if (!tenantUserIds.length) {
        return ResultData.ok({ list: [], total: 0 });
      }
      entity.andWhere('user.id IN (:...tenantUserIds)', { tenantUserIds });
    }

    //数据权限过滤
    if (user) {
      const roles = user.roles;
      const deptIds: number[] = [];
      let dataScopeAll = false;
      let dataScopeSelf = false;
      for (let index = 0; index < roles.length; index++) {
        const role = roles[index];
        const scope = String(role.dataScope);
        if (scope === DataScopeEnum.DATA_SCOPE_ALL) {
          dataScopeAll = true;
          break;
        } else if (scope === DataScopeEnum.DATA_SCOPE_CUSTOM) {
          const roleWithDeptIds = await this.roleService.findRoleWithDeptIds(role.id);
          deptIds.push(...roleWithDeptIds);
        } else if (scope === DataScopeEnum.DATA_SCOPE_DEPT || scope === DataScopeEnum.DATA_SCOPE_DEPT_AND_CHILD) {
          const dataScopeWidthDeptIds = await this.deptService.findDeptIdsByDataScope(user.deptId, scope as DataScopeEnum);
          deptIds.push(...dataScopeWidthDeptIds);
        } else if (scope === DataScopeEnum.DATA_SCOPE_SELF) {
          dataScopeSelf = true;
        }
      }

      if (!dataScopeAll) {
        if (deptIds.length > 0) {
          entity.andWhere('user.deptId IN (:...deptIds)', { deptIds: deptIds });
        } else if (dataScopeSelf) {
          entity.andWhere('user.id = :userId', { userId: user.id });
        }
      }
    }

    if (query.dept_id) {
      const deptIds = await this.deptService.findDeptIdsByDataScope(+query.dept_id, DataScopeEnum.DATA_SCOPE_DEPT_AND_CHILD);
      entity.andWhere('user.deptId IN (:...deptIds)', { deptIds: deptIds });
    }

    if (query.username) {
      entity.andWhere(`user.username LIKE "%${query.username}%"`);
    }

    if (query.phone) {
      entity.andWhere(`user.phone LIKE "%${query.phone}%"`);
    }

    if (query.status !== undefined && query.status !== null) {
      entity.andWhere('user.status = :status', { status: query.status });
    }

    if ((query as any).params?.beginTime && (query as any).params?.endTime) {
      entity.andWhere('user.createTime BETWEEN :start AND :end', { start: (query as any).params.beginTime, end: (query as any).params.endTime });
    }

    //联查部门详情
    entity.leftJoinAndMapOne('user.dept', SysDeptEntity, 'dept', 'dept.id = user.deptId');

    const pageNum = +(query.pageNum || (query as any).page || 1);
    const pageSize = +(query.pageSize || (query as any).limit || 10);
    entity.skip(pageSize * (pageNum - 1)).take(pageSize);

    const [list, total] = await entity.getManyAndCount();

    return ResultData.ok({
      list: list.map((item) => this.formatUserRow(item as UserEntity & { dept?: SysDeptEntity })),
      total,
      page: pageNum,
      current_page: pageNum,
      size: pageSize,
      per_page: pageSize,
    });
  }

  /**
   * 用户角色+岗位信息
   * @returns
   */
  async findPostAndRoleAll() {
    const tenantId = getTenantId();
    const postWhere: Record<string, any> = { deleteTime: IsNull() };
    const roleWhere: Record<string, any> = { deleteTime: IsNull() };
    if (tenantId) {
      postWhere.tenantId = tenantId;
      roleWhere.tenantId = tenantId;
    }
    const posts = await this.sysPostEntityRep.find({ where: postWhere });
    const roles = await this.roleService.findRoles({ where: roleWhere });

    return ResultData.ok({
      posts,
      roles,
    });
  }

  @Cacheable(CacheEnum.SYS_USER_KEY, '{userId}')
  async findOne(userId: number) {
    const data = await this.userRepo.findOne({
      where: {
        deleteTime: IsNull(),
        id: userId,
      },
    });

    if (!data) {
      return ResultData.fail(404, '用户不存在');
    }

    const dept = data.deptId
      ? await this.sysDeptEntityRep.findOne({
          where: {
            deleteTime: IsNull(),
            id: data.deptId,
          },
        })
      : null;

    const postList = await this.sysUserWithPostEntityRep.find({
      where: {
        userId: userId,
      },
    });
    const postIds = postList.map((item) => Number(item.postId));
    const allPosts = postIds.length
      ? await this.sysPostEntityRep.find({
          where: {
            deleteTime: IsNull(),
            id: In(postIds),
          },
        })
      : [];

    const roleIds = (await this.getRoleIds([userId])).map((id) => Number(id));
    const allRoles = roleIds.length
      ? await this.roleService.findRoles({
          where: {
            deleteTime: IsNull(),
            id: In(roleIds),
          },
        })
      : [];

    const roleList = allRoles.filter((item) => roleIds.includes(Number(item.id)));
    const userPosts = allPosts.filter((item) => postIds.includes(Number(item.id)));
    const menuIds = await this.getUserMenuIds(userId);

    delete (data as any).password;

    return ResultData.ok({
      id: Number(data.id),
      username: data.username,
      realname: data.realname,
      avatar: data.avatar,
      email: data.email,
      phone: data.phone,
      gender: data.gender != null ? String(data.gender) : '',
      status: Number(data.status),
      remark: data.remark,
      dashboard: data.dashboard,
      dept_id: data.deptId ? Number(data.deptId) : null,
      dept,
      role_ids: roleIds.map((id) => Number(id)),
      post_ids: postIds.map((id) => Number(id)),
      roleList: roleList.map((item) => ({ id: Number(item.id), name: item.name, code: item.code })),
      postList: userPosts.map((item) => ({ id: Number(item.id), name: item.name, code: item.code })),
      menu_ids: menuIds.map((id) => Number(id)),
    });
  }

  /**
   * 更新用户
   * @param updateUserDto
   * @returns
   */
  @CacheEvict(CacheEnum.SYS_USER_KEY, '{updateUserDto.id}')
  async update(updateUserDto: UpdateUserDto, userId: number) {
    if (updateUserDto.id === 1) throw new BadRequestException('非法操作！');

    const { role_ids, post_ids, dept_id, password_confirm, ...fields } = updateUserDto as any;

    updateUserDto.role_ids = (role_ids || []).filter((v) => v != 1);

    if (updateUserDto.id === userId) {
      delete fields.status;
    }

    const tenantId = getTenantId();
    const relWhere = (uid: number) => (tenantId ? { userId: uid, tenantId } : { userId: uid });

    let data: unknown;
    await this.dataSource.transaction(async (manager) => {
      if (post_ids !== undefined) {
        await manager.delete(SysUserPostEntity, relWhere(updateUserDto.id));
        if (post_ids.length) {
          const postValues = post_ids.map((id) => ({
            userId: updateUserDto.id,
            postId: id,
            ...(tenantId ? { tenantId } : {}),
          }));
          await manager.insert(SysUserPostEntity, postValues);
        }
      }

      if (role_ids !== undefined) {
        await manager.delete(SysUserRoleEntity, relWhere(updateUserDto.id));
        const filteredRoleIds = (role_ids || []).filter((v) => v != 1);
        if (filteredRoleIds.length) {
          const roleValues = filteredRoleIds.map((id) => ({
            userId: updateUserDto.id,
            roleId: id,
            ...(tenantId ? { tenantId } : {}),
          }));
          await manager.insert(SysUserRoleEntity, roleValues);
        }
      }

      const updateEntity: Record<string, any> = {};
      if (fields.username !== undefined) updateEntity.username = fields.username;
      if (fields.realname !== undefined) updateEntity.realname = fields.realname;
      if (fields.email !== undefined) updateEntity.email = fields.email;
      if (fields.phone !== undefined) updateEntity.phone = fields.phone;
      if (fields.gender !== undefined) updateEntity.gender = fields.gender;
      if (fields.avatar !== undefined) updateEntity.avatar = fields.avatar;
      if (fields.status !== undefined) updateEntity.status = fields.status;
      if (fields.remark !== undefined) updateEntity.remark = fields.remark;
      if (fields.dashboard !== undefined) updateEntity.dashboard = fields.dashboard;
      if (dept_id !== undefined) updateEntity.deptId = dept_id;

      data = await manager.update(UserEntity, { id: updateUserDto.id }, updateEntity);
    });

    await this.clearUserRuntimeCache(updateUserDto.id);
    return ResultData.ok(data);
  }

  @CacheEvict(CacheEnum.SYS_USER_KEY, '{userId}')
  async clearCacheByUserId(userId: number) {
    await this.clearUserRuntimeCache(userId);
    return ResultData.ok(null, '缓存清理成功');
  }

  private async getTenantUserIds(tenantId: number) {
    const rows = await this.sysUserTenantEntityRep.find({
      where: { tenantId, deleteTime: IsNull() },
      select: { userId: true },
    });
    return rows.map((row) => Number(row.userId));
  }

  /**
   * 清除用户运行时缓存（权限、菜单、角色、用户信息）
   * @param userId 用户ID
   */
  private async clearUserRuntimeCache(userId: number) {
    await this.redisService.del(`user:permissions:${userId}`);
    // 清除该用户在所有租户下的菜单缓存: sys_menu:{tid}:{userId}
    const menuKeys = await this.redisService.keys(`${CacheEnum.SYS_MENU_KEY}*:${userId}`);
    if (menuKeys?.length) {
      await this.redisService.del(menuKeys);
    }
    await this.redisService.del(`user:roles:${userId}`);
    // 清除用户信息缓存
    await this.redisService.del(`${CacheEnum.SYS_USER_KEY}profile:${userId}`);
  }

  /** ponytail: login should not block on external geo-ip; timeout fallback keeps auth responsive */
  private async resolveLoginLocationFast(ip: string): Promise<string> {
    const timeoutMs = 600;
    try {
      const location = await Promise.race<string>([
        this.axiosService.getIpAddress(ip),
        new Promise<string>((resolve) => setTimeout(() => resolve('未知'), timeoutMs)),
      ]);
      return String(location || '未知');
    } catch {
      return '未知';
    }
  }

  /**
   * 获取用户已分配的菜单ID列表
   * @param userId 用户ID
   * @param tenantId 可选租户ID
   * @returns 菜单ID数组
   */
  private async getUserMenuIds(userId: number, tenantId?: number) {
    const tid = tenantId ?? getTenantId();
    const where: Record<string, any> = {
      userId,
      deleteTime: IsNull(),
    };
    if (tid !== undefined && tid !== null) {
      where.tenantId = tid;
    }
    const list = await this.sysUserMenuEntityRep.find({
      where,
      select: { menuId: true },
    });
    return list.map((item) => Number(item.menuId));
  }

  /**
   * 登陆
   */
  @Captcha('user')
  async login(user: Record<string, any>, clientInfo: ClientInfoDto) {
    const username = user.username || '';
    const password = user.password || '';
    const tenantId = user.tenant_id || null;

    if (!username || !password) {
      return ResultData.fail(500, '用户名和密码不能为空');
    }

    if (!tenantId) {
      return ResultData.fail(500, '租户ID不能为空');
    }

    const data = await this.userRepo.findOne({
      where: { username },
      select: { id: true, password: true },
    });

    if (!data || !bcrypt.compareSync(password, data.password)) {
      return ResultData.fail(500, '帐号或密码错误');
    }

    const userData = await this.getUserinfo(data.id);

    if (userData.deleteTime) {
      return ResultData.fail(500, `您已被禁用，如需正常使用请联系管理员`);
    }
    if (userData.status === 0) {
      return ResultData.fail(500, `您已被停用，如需正常使用请联系管理员`);
    }

    /**
     * 更新用户登录信息
     */
    const loginDate = new Date();
    await this.userRepo.update(
      {
        id: data.id,
      },
      {
        loginTime: loginDate,
        loginIp: clientInfo.ipaddr,
      },
    );

    const uuid = generateUUID();
    const token = this.createToken({ uuid: uuid, userId: userData.id });
    const refreshToken = await this.createRefreshToken(userData.id);
    const permissions = await this.getUserPermissions(userData.id);
    const deptData = await this.sysDeptEntityRep.findOne({
      where: {
        id: userData.deptId,
      },
      select: { name: true },
    });

    /**
     * 设置公司名称
     */
    userData['deptName'] = deptData?.name || '';
    const roles = userData.roles.map((item) => item.code);

    /**
     * 获取登录 IP 地理位置
     */
    const loginLocation = await this.resolveLoginLocationFast(clientInfo.ipaddr);

    const userInfo = {
      browser: clientInfo.browser,
      ipaddr: clientInfo.ipaddr,
      loginLocation,
      loginTime: loginDate,
      os: clientInfo.os,
      permissions: permissions,
      roles: roles,
      token: uuid,
      user: userData,
      userId: userData.id,
      userName: userData.username,
      deptId: userData.deptId,
      tenantId: Number(tenantId),
    };

    const menus = await this.menuService.getMenuListByUserId(userData.id, tenantId);

    await this.updateRedisToken(uuid, userInfo);

    return ResultData.ok(
      {
        user: {
          id: userData.id,
          username: userData.username,
          nickname: userData.realname,
          avatar: userData.avatar,
          is_admin: userData.isSuper || false,
        },
        access_token: token,
        refresh_token: refreshToken,
        expires_in: ACCESS_TOKEN_EXPIRESIN,
        tenant_id: user.tenant_id || 0,
        menus: menus,
        permissions: permissions,
      },
      '登录成功',
    );
  }

  /**
   * 更新redis中用户权限和角色信息
   */
  async updateRedisUserRolesAndPermissions(uuid: string, userId: number) {
    const userData = await this.getUserinfo(userId);

    const permissions = await this.getUserPermissions(userId);
    const roles = userData.roles.map((item) => item.code);

    await this.updateRedisToken(uuid, {
      permissions: permissions,
      roles: roles,
    });
  }

  /**
   * 登录态缓存脱敏（移除密码等敏感字段）
   */
  private sanitizeTokenMeta(meta: Partial<UserType> | Record<string, any>) {
    const clone = JSON.parse(JSON.stringify(meta || {}));
    const sanitize = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach((item) => sanitize(item));
        return;
      }
      delete obj.password;
      delete obj.passwd;
      delete obj.passwordHash;
      Object.keys(obj).forEach((key) => sanitize(obj[key]));
    };
    sanitize(clone);
    return clone;
  }

  /**
   * 更新redis中的元数据
   * @param token
   * @param metaData
   */
  async updateRedisToken(token: string, metaData: Partial<UserType>) {
    const oldMetaData = await this.redisService.get(`${CacheEnum.LOGIN_TOKEN_KEY}${token}`);

    let newMetaData: any = metaData;
    if (oldMetaData) {
      newMetaData = Object.assign(oldMetaData, metaData);
    }

    const sanitized = this.sanitizeTokenMeta(newMetaData);
    await this.redisService.set(`${CacheEnum.LOGIN_TOKEN_KEY}${token}`, sanitized, LOGIN_TOKEN_EXPIRESIN);
  }

  /**
   * 获取角色Id列表
   * @param userId
   * @returns
   */
  async isSuperAdmin(userId: number): Promise<boolean> {
    const user: any = await this.userRepo.findOne({
      where: { id: userId },
      select: { isSuper: true },
    });
    return user?.isSuper === 1;
  }

  /**
   * 获取角色ID列表
   * @param userIds 用户ID集合
   * @returns 角色ID集合
   */
  async getRoleIds(userIds: Array<number>, tenantId?: number) {
    const tid = tenantId ?? getTenantId();
    const where: Record<string, any> = { userId: In(userIds) };
    if (tid) {
      where.tenantId = tid;
    }
    const roleList = await this.sysUserWithRoleEntityRep.find({
      where,
      select: { roleId: true },
    });
    const roleIds = roleList.map((item) => item.roleId);
    return uniq(roleIds);
  }

  /**
   * 获取权限列表
   * @param userId
   * @returns
   */
  async getUserPermissions(userId: number) {
    const isSuper = await this.isSuperAdmin(userId);
    if (isSuper) {
      return ['*:*:*'];
    }
    const roleIds = await this.getRoleIds([userId]);
    const list = await this.roleService.getPermissionsByRoleIds(roleIds);
    const permissions = uniq(list.map((item: any) => item.slug)).filter((item) => {
      return item;
    });
    return permissions;
  }

  /**
   * 获取用户信息
   */
  async getUserinfo(userId: number): Promise<{ dept: SysDeptEntity; roles: Array<SysRoleEntity>; posts: Array<SysPostEntity> } & UserEntity> {
    const entity = this.userRepo.createQueryBuilder('user');
    entity.where({
      id: userId,
      deleteTime: IsNull(),
    });
    //联查部门详情
    entity.leftJoinAndMapOne('user.dept', SysDeptEntity, 'dept', 'dept.id = user.deptId');
    const roleIds = await this.getRoleIds([userId]);
    const tid = getTenantId();
    const roleWhere: Record<string, any> = {
      deleteTime: IsNull(),
      id: In(roleIds),
    };
    if (tid) {
      roleWhere.tenantId = tid;
    }

    const roles = roleIds.length
      ? await this.roleService.findRoles({
          where: roleWhere,
        })
      : [];

    const postWhere: Record<string, any> = { userId };
    if (tid) {
      postWhere.tenantId = tid;
    }
    const postIds = (
      await this.sysUserWithPostEntityRep.find({
        where: postWhere,
        select: { postId: true },
      })
    ).map((item) => item.postId);

    const postsWhere: Record<string, any> = {
      deleteTime: IsNull(),
      id: In(postIds),
    };
    if (tid) {
      postsWhere.tenantId = tid;
    }
    const posts = postIds.length
      ? await this.sysPostEntityRep.find({
          where: postsWhere,
        })
      : [];

    const data = await entity.getOne();

    const result = {
      ...data,
      roles,
      posts,
      dept: (data as any).dept,
    };

    return result as any;
  }

  /** JWT 守卫用：按 userId 加载用户（含角色与权限） */
  async findOneUser(userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId, deleteTime: IsNull() } as any,
    });
    if (!user) return null;

    const roleIds = await this.getRoleIds([userId]);
    const roles = roleIds.length
      ? await this.roleService.findRoles({
          where: { id: In(roleIds), deleteTime: IsNull() } as any,
        })
      : [];
    const permissions = await this.getUserPermissions(userId);

    return {
      userId: user.id,
      username: user.username,
      realname: user.realname,
      avatar: user.avatar,
      email: user.email,
      phone: user.phone,
      gender: user.gender,
      status: String(user.status),
      deptId: user.deptId,
      isSuper: user.isSuper,
      isAdmin: user.isSuper === 1,
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        roleId: r.id,
        roleKey: r.code,
        dataScope: String(r.dataScope),
      })),
      permissions,
    };
  }

  /**
   * 注册
   */
  async register(user: RegisterDto) {
    const loginDate = getNowDate();
    const salt = bcrypt.genSaltSync(10);
    if (user.password) {
      user.password = await bcrypt.hashSync(user.password, salt);
    }
    const checkUserNameUnique = await this.userRepo.findOne({
      where: {
        username: user.username,
      },
      select: { username: true },
    });
    if (checkUserNameUnique) {
      return ResultData.fail(500, `保存用户'${user.username}'失败，注册账号已存在`);
    }
    await this.userRepo.save({ username: user.username, realname: user.username, password: user.password, loginTime: loginDate });
    return ResultData.ok();
  }

  /**
   * 从数据声明生成令牌
   *
   * @param payload 数据声明
   * @return 令牌
   */
  createToken(payload: { uuid: string; userId: number }): string {
    const accessToken = this.jwtService.sign(payload, { expiresIn: ACCESS_TOKEN_EXPIRESIN });
    return accessToken;
  }

  /**
   * 从令牌中获取数据声明
   *
   * @param token 令牌
   * @return 数据声明
   */
  parseToken(token: string) {
    try {
      if (!token) return null;
      const payload = this.jwtService.verify(token.replace('Bearer ', ''));
      return payload;
    } catch (error) {
      return null;
    }
  }

  /** JWT 守卫：从 Redis 读取完整登录态（含 tenantId） */
  async getSessionByAccessToken(authorization: string): Promise<UserType | null> {
    const token = authorization.replace(/^Bearer\s+/i, '');
    const payload = this.parseToken(token);
    if (!payload?.uuid) return null;
    return this.redisService.get(`${CacheEnum.LOGIN_TOKEN_KEY}${payload.uuid}`);
  }

  /**
   * 生成不透明 refreshToken（类似 PHP 方案）
   * 返回 128位随机 hex 字符串，SHA256 哈希后存入 Redis
   */
  async createRefreshToken(userId: number): Promise<string> {
    const rawToken = crypto.randomBytes(64).toString('hex');
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await this.redisService.set(`${REFRESH_TOKEN_KEY}${hash}`, userId, REFRESH_TOKEN_EXPIRESIN);
    return rawToken;
  }

  /**
   * 校验 refreshToken，返回 userId 或 null
   */
  async validateRefreshToken(rawToken: string): Promise<number | null> {
    if (!rawToken) return null;
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const userId = await this.redisService.get(`${REFRESH_TOKEN_KEY}${hash}`);
    return userId ? Number(userId) : null;
  }

  /**
   * 删除 refreshToken（一次性使用，轮换时调用）
   */
  async deleteRefreshToken(rawToken: string): Promise<void> {
    if (!rawToken) return;
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await this.redisService.del(`${REFRESH_TOKEN_KEY}${hash}`);
  }

  /**
   * 重置密码
   * @param body
   * @returns
   */
  async resetPwd(body: ResetPwdDto) {
    if (body.id === 1) {
      return ResultData.fail(500, '系统用户不能重置密码');
    }
    if (body.password) {
      body.password = await bcrypt.hashSync(body.password, bcrypt.genSaltSync(10));
    }
    await this.userRepo.update(
      {
        id: body.id,
      },
      {
        password: body.password,
      },
    );
    return ResultData.ok();
  }

  /**
   * 批量删除用户
   * @param ids
   * @returns
   */
  async remove(ids: number[]) {
    // 忽略系统角色的删除 (isSuper=1 means system user)
    const users = await this.userRepo.find({
      where: { id: In(ids), isSuper: 0 },
      select: { id: true },
    });
    const removableIds = users.map((u) => u.id);
    if (removableIds.length) {
      await this.userRepo.softDelete(removableIds);
    }
    return ResultData.ok();
  }

  /**
   * 角色详情
   * @param id
   * @returns
   */
  async authRole(userId: number) {
    const allRoles = await this.roleService.findRoles({
      where: {
        deleteTime: IsNull(),
      },
    });

    const user: any = await this.userRepo.findOne({
      where: {
        deleteTime: IsNull(),
        id: userId,
      },
    });

    const dept = await this.sysDeptEntityRep.findOne({
      where: {
        deleteTime: IsNull(),
        id: user.deptId,
      },
    });
    user['dept'] = dept;

    const roleIds = await this.getRoleIds([userId]);
    //TODO flag用来给前端表格标记选中状态，后续优化
    user['roles'] = allRoles.filter((item) => {
      if (roleIds.includes(item.id)) {
        item['flag'] = true;
        return true;
      } else {
        return true;
      }
    });

    return ResultData.ok({
      roles: allRoles,
      user,
    });
  }

  /**
   * 更新用户角色信息
   * @param query
   * @returns
   */
  async updateAuthRole(query) {
    let roleIds = query.roleIds.split(',');

    roleIds = roleIds.filter((v) => v != 1);

    if (!roleIds?.length) {
      return ResultData.ok();
    }

    const userId = +query.userId;
    const tenantId = getTenantId();
    const relWhere = tenantId ? { userId, tenantId } : { userId };

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SysUserRoleEntity, relWhere);
      const roleValues = roleIds.map((id) => ({
        userId,
        roleId: +id,
        ...(tenantId ? { tenantId } : {}),
      }));
      await manager.insert(SysUserRoleEntity, roleValues);
    });

    await this.clearUserRuntimeCache(userId);
    return ResultData.ok();
  }

  /**
   * 修改用户状态
   * @param changeStatusDto
   * @returns
   */
  async changeStatus(changeStatusDto: ChangeStatusDto) {
    const userData = await this.userRepo.findOne({
      where: {
        id: changeStatusDto.id,
      },
      select: { isSuper: true },
    });
    if ((userData as any).isSuper) {
      return ResultData.fail(500, '系统角色不可停用');
    }

    const res = await this.userRepo.update(
      { id: changeStatusDto.id },
      {
        status: changeStatusDto.status,
      },
    );
    return ResultData.ok(res);
  }

  /**
   * 部门树
   * @returns
   */
  async deptTree() {
    const tree = await this.deptService.deptTree();
    return ResultData.ok(tree);
  }

  /**
   * 获取角色已分配用户
   * @param query
   * @returns
   */
  async allocatedList(query: AllocatedListDto) {
    const roleWidthRoleList = await this.sysUserWithRoleEntityRep.find({
      where: {
        roleId: +(query as any).role_id,
      },
      select: { userId: true },
    });
    if (roleWidthRoleList.length === 0) {
      return ResultData.ok({
        list: [],
        total: 0,
      });
    }
    const userIds = roleWidthRoleList.map((item) => item.userId);
    const entity = this.userRepo.createQueryBuilder('user');
    entity.where('user.deleteTime IS NULL');
    entity.andWhere('user.status = :status', { status: 1 });
    entity.andWhere('user.id IN (:...userIds)', { userIds: userIds });
    if (query.username) {
      entity.andWhere(`user.username LIKE "%${query.username}%"`);
    }

    if (query.phone) {
      entity.andWhere(`user.phone LIKE "%${query.phone}%"`);
    }
    entity.skip(query.pageSize! * (query.pageNum! - 1)).take(query.pageSize!);
    //联查部门详情
    entity.leftJoinAndMapOne('user.dept', SysDeptEntity, 'dept', 'dept.id = user.deptId');
    const [list, total] = await entity.getManyAndCount();
    return ResultData.ok({
      list,
      total,
    });
  }

  /**
   * 获取角色未分配用户
   * @param query
   * @returns
   */
  async unallocatedList(query: AllocatedListDto) {
    const roleWidthRoleList = await this.sysUserWithRoleEntityRep.find({
      where: {
        roleId: +(query as any).role_id,
      },
      select: { userId: true },
    });

    const userIds = roleWidthRoleList.map((item) => item.userId);
    const entity = this.userRepo.createQueryBuilder('user');
    entity.where('user.deleteTime IS NULL');
    entity.andWhere('user.status = :status', { status: 1 });
    entity.andWhere({
      id: Not(In(userIds)),
    });
    if (query.username) {
      entity.andWhere(`user.username LIKE "%${query.username}%"`);
    }

    if (query.phone) {
      entity.andWhere(`user.phone LIKE "%${query.phone}%"`);
    }
    entity.skip(query.pageSize! * (query.pageNum! - 1)).take(query.pageSize!);
    //联查部门详情
    entity.leftJoinAndMapOne('user.dept', SysDeptEntity, 'dept', 'dept.id = user.deptId');
    const [list, total] = await entity.getManyAndCount();
    return ResultData.ok({
      list,
      total,
    });
  }

  /**
   * 用户解绑角色
   * @param data
   * @returns
   */
  async authUserCancel(data: AuthUserCancelDto) {
    await this.sysUserWithRoleEntityRep.delete({
      userId: data.user_id,
      roleId: data.role_id,
    });
    return ResultData.ok();
  }

  /**
   * 用户批量解绑角色
   * @param data
   * @returns
   */
  async authUserCancelAll(data: AuthUserCancelAllDto) {
    const userIds = data.user_ids.split(',').map((id) => +id);
    await this.sysUserWithRoleEntityRep.delete({
      userId: In(userIds),
      roleId: +data.role_id,
    });
    return ResultData.ok();
  }

  /**
   * 用户批量绑定角色
   * @param data
   * @returns
   */
  async authUserSelectAll(data: AuthUserSelectAllDto) {
    const userIds = data.user_ids.split(',');
    const entitys = userIds.map((userId) => {
      const sysDeptEntityEntity = new SysUserRoleEntity();
      return Object.assign(sysDeptEntityEntity, {
        userId: userId,
        roleId: +data.role_id,
      });
    });
    await this.sysUserWithRoleEntityRep.save(entitys);
    return ResultData.ok();
  }

  /**
   * 个人中心-用户信息
   * @param user
   * @returns
   */
  async profile(user) {
    return ResultData.ok(user);
  }

  /**
   * 个人中心-用户信息
   * @param user
   * @returns
   */
  async updateProfile(user: UserType, updateProfileDto: UpdateProfileDto) {
    await this.userRepo.update({ id: user.user.id }, updateProfileDto);
    const userData = await this.redisService.get(`${CacheEnum.LOGIN_TOKEN_KEY}${user.token}`);
    userData.user = Object.assign(userData.user, updateProfileDto);
    await this.updateRedisToken(user.token, userData);
    return ResultData.ok();
  }

  /**
   * 个人中心-修改密码
   * @param user
   * @param updatePwdDto
   * @returns
   */
  async updatePwd(user: UserType, updatePwdDto: UpdatePwdDto) {
    if (updatePwdDto.oldPassword === updatePwdDto.newPassword) {
      return ResultData.fail(500, '新密码不能与旧密码相同');
    }

    const currentUser = await this.userRepo.findOne({
      where: { id: user.user.id },
      select: { password: true },
    });

    if (!currentUser?.password || !bcrypt.compareSync(updatePwdDto.oldPassword, currentUser.password)) {
      return ResultData.fail(500, '修改密码失败，旧密码错误');
    }

    const password = await bcrypt.hashSync(updatePwdDto.newPassword, bcrypt.genSaltSync(10));
    await this.userRepo.update({ id: user.user.id }, { password: password });
    return ResultData.ok();
  }

  /**
   * 导出用户信息数据为xlsx
   * @param res
   */
  async export(res: Response, body: ListUserDto, user: UserType['user']) {
    delete (body as any).pageNum;
    delete (body as any).pageSize;
    const list = await this.findAll(body, user);
    const options = {
      sheetName: '用户数据',
      data: list.data.list,
      header: [
        { title: '用户序号', dataIndex: 'id' },
        { title: '登录名称', dataIndex: 'username' },
        { title: '用户昵称', dataIndex: 'realname' },
        { title: '用户邮箱', dataIndex: 'email' },
        { title: '手机号码', dataIndex: 'phone' },
        { title: '用户性别', dataIndex: 'gender' },
        { title: '账号状态', dataIndex: 'status' },
        { title: '最后登录IP', dataIndex: 'loginIp' },
        { title: '最后登录时间', dataIndex: 'loginTime', width: 20 },
        { title: '部门', dataIndex: 'dept.name' },
        { title: '部门负责人', dataIndex: 'dept.leaderId' },
      ],
    };
    ExportTable(options, res);
  }

  /**
   * 刷新Token
   */
  private async getDefaultTenantId(userId: number): Promise<number | null> {
    const preferred = await this.sysUserTenantEntityRep.findOne({
      where: { userId, isDefault: 1, deleteTime: IsNull() },
      select: { tenantId: true },
    });
    if (preferred?.tenantId) return Number(preferred.tenantId);

    const any = await this.sysUserTenantEntityRep.findOne({
      where: { userId, deleteTime: IsNull() },
      order: { id: 'ASC' },
      select: { tenantId: true },
    });
    return any?.tenantId ? Number(any.tenantId) : null;
  }

  /** 从 Authorization 解析旧登录态 */
  private async loadLoginSession(authorization?: string): Promise<{
    session: Partial<UserType> | null;
    uuid: string | null;
  }> {
    if (!authorization) return { session: null, uuid: null };
    const session = await this.getSessionByAccessToken(authorization);
    if (!session) return { session: null, uuid: null };
    const token = authorization.replace(/^Bearer\s+/i, '');
    const payload = this.parseToken(token);
    return { session, uuid: payload?.uuid ?? session.token ?? null };
  }

  /**
   * 刷新访问令牌（使用 refreshToken 轮换机制）
   * 校验旧 refreshToken，生成新的 access_token 和 refresh_token，
   * 重建 Redis 登录态并清理旧会话
   * @param body.refreshToken 刷新令牌
   * @param body.authorization 旧访问令牌（用于提取登录态信息）
   * @returns 新的令牌对象
   */
  async refreshToken(body: { refreshToken?: string; authorization?: string }) {
    if (!body.refreshToken) {
      return ResultData.fail(500, '刷新令牌不能为空');
    }
    const userId = await this.validateRefreshToken(body.refreshToken);
    if (!userId) {
      return ResultData.fail(500, '刷新令牌已过期，请重新登录');
    }

    const { session: oldSession, uuid: oldUuid } = await this.loadLoginSession(body.authorization);
    let tenantId =
      oldSession?.tenantId != null && Number(oldSession.tenantId) > 0
        ? Number(oldSession.tenantId)
        : null;
    if (!tenantId) {
      tenantId = await this.getDefaultTenantId(userId);
    }

    await this.deleteRefreshToken(body.refreshToken);

    const uuid = generateUUID();
    const newAccessToken = this.createToken({ uuid, userId });
    const newRefreshToken = await this.createRefreshToken(userId);

    const buildSession = async () => {
      const userData = await this.getUserinfo(userId);
      if (userData.deleteTime) {
        return ResultData.fail(500, '用户已删除');
      }
      if (userData.status === 0) {
        return ResultData.fail(500, '用户已停用');
      }

      const permissions = await this.getUserPermissions(userId);
      const roles = userData.roles.map((item) => item.code);
      const deptData = userData.deptId
        ? await this.sysDeptEntityRep.findOne({
            where: { id: userData.deptId },
            select: { name: true },
          })
        : null;
      userData['deptName'] = deptData?.name || '';

      await this.updateRedisToken(uuid, {
        browser: oldSession?.browser ?? '',
        ipaddr: oldSession?.ipaddr ?? '',
        loginLocation: oldSession?.loginLocation ?? '',
        loginTime: oldSession?.loginTime ?? new Date(),
        os: oldSession?.os ?? '',
        permissions,
        roles,
        token: uuid,
        user: userData,
        userId,
        userName: userData.username,
        deptId: userData.deptId,
        tenantId: tenantId ?? 0,
      });

      if (oldUuid && oldUuid !== uuid) {
        await this.redisService.del(`${CacheEnum.LOGIN_TOKEN_KEY}${oldUuid}`);
      }

      return ResultData.ok(
        {
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          expires_in: ACCESS_TOKEN_EXPIRESIN,
        },
        '刷新成功',
      );
    };

    if (tenantId) {
      return TenantContext.run({ tenantId, userId: Number(userId) } as any, buildSession);
    }
    return buildSession();
  }

  /**
   * 根据用户名获取租户列表
   */
  async getTenantsByUsername(username: string) {
    if (!username) {
      return ResultData.ok([]);
    }
    // Find user by username
    const user: any = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      return ResultData.ok([]);
    }
    // Find tenant associations for this user
    const userTenants = await this.sysUserTenantEntityRep.find({
      where: { userId: user.id },
    });
    if (!userTenants.length) {
      return ResultData.ok([]);
    }
    // Find tenant details
    const tenantIds = userTenants.map((ut) => ut.tenantId);
    const tenants = await this.tenantEntityRep.find({
      where: { id: In(tenantIds), status: 1 },
    });
    // Map to response format
    const result = tenants.map((t) => {
      const ut = userTenants.find((u) => u.tenantId === t.id);
      return {
        id: t.id,
        name: t.tenantName,
        code: t.tenantCode,
        is_default: (ut?.isDefault || 0) === 1,
        status: t.status,
      };
    });
    return ResultData.ok(result);
  }

  /**
   * 切换租户
   */
  async switchTenant(body: Record<string, any>, user: UserType) {
    const userId = user.userId;
    const newTenantId = Number(body.tenant_id ?? body.tenantId);

    if (!userId) {
      return ResultData.fail(401, '未登录');
    }
    if (!newTenantId) {
      return ResultData.fail(400, '租户ID不能为空');
    }

    const userTenant = await this.sysUserTenantEntityRep.findOne({
      where: { userId, tenantId: newTenantId, deleteTime: IsNull() },
    });
    if (!userTenant) {
      return ResultData.fail(403, '您不属于该租户');
    }

    const tenant = await this.tenantEntityRep.findOne({
      where: { id: newTenantId, status: 1, deleteTime: IsNull() },
    });
    if (!tenant) {
      return ResultData.fail(403, '租户无效或已过期');
    }

    await this.sysUserTenantEntityRep.update({ userId, isDefault: 1 }, { isDefault: 0 });
    await this.sysUserTenantEntityRep.update({ userId, tenantId: newTenantId }, { isDefault: 1 });
    await this.clearUserRuntimeCache(userId);

    const uuid = user.token;
    const accessToken = this.createToken({ uuid, userId });
    const refreshToken = await this.createRefreshToken(userId);

    return await TenantContext.run({ tenantId: newTenantId, userId: Number(userId) } as any, async () => {
      const userData = await this.getUserinfo(userId);
      const permissions = await this.getUserPermissions(userId);
      const roles = userData.roles.map((item) => item.code);
      const menus = await this.menuService.getMenuListByUserId(userId);

      await this.updateRedisToken(uuid, {
        permissions,
        roles,
        tenantId: newTenantId,
        user: userData,
      });

      return ResultData.ok(
        {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: ACCESS_TOKEN_EXPIRESIN,
          tenant_id: newTenantId,
          tenant_name: tenant.tenantName,
          menus,
          permissions,
        },
        '切换成功',
      );
    });
  }

  /**
   * 获取租户信息
   */
  async getTenantInfo(tenantId: number) {
    if (!tenantId) return null;
    return await this.tenantEntityRep.findOne({
      where: { id: tenantId, status: 1, deleteTime: IsNull() },
    });
  }

  /**
   * 设置用户首页
   */
  async setHomePage(userId: number, body: SetHomePageDto) {
    await this.userRepo.update({ id: userId }, { dashboard: body.dashboard });
    return ResultData.ok();
  }

  /**
   * 用户选择器列表（部门领导等场景）
   */
  async getSelectorList(params: Record<string, any>) {
    const page = Math.max(1, Number(params.page || params.pageNum || 1));
    const limit = Math.max(1, Number(params.limit || params.pageSize || 5));
    const keyword = String(params.keyword || '').trim();
    const status = params.status;

    const entity = this.userRepo.createQueryBuilder('user');
    entity.where('user.deleteTime IS NULL');

    const tenantId = getTenantId();
    if (tenantId) {
      const tenantUserIds = await this.getTenantUserIds(tenantId);
      if (!tenantUserIds.length) {
        return ResultData.ok({ list: [], total: 0, page, limit });
      }
      entity.andWhere('user.id IN (:...tenantUserIds)', { tenantUserIds });
    }

    if (keyword) {
      entity.andWhere('(user.username LIKE :keyword OR user.realname LIKE :keyword OR user.phone LIKE :keyword)', {
        keyword: `%${keyword}%`,
      });
    }

    if (status !== undefined && status !== null && status !== '') {
      entity.andWhere('user.status = :status', { status: Number(status) });
    }

    const total = await entity.getCount();
    const list = await entity
      .select(['user.id', 'user.username', 'user.realname', 'user.phone', 'user.avatar', 'user.email', 'user.status'])
      .orderBy('user.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return ResultData.ok({
      list,
      total,
      page,
      limit,
    });
  }

  /**
   * 获取用户已分配菜单ID
   */
  async getUserMenus(userId: number) {
    const menuIds = await this.getUserMenuIds(userId);
    return ResultData.ok(menuIds);
  }

  /**
   * 保存用户菜单分配
   */
  async saveUserMenus(userId: number, menuIds: number[]) {
    const user: any = await this.userRepo.findOne({
      where: {
        id: userId,
        deleteTime: IsNull(),
      },
    });
    if (!user) {
      return ResultData.fail(404, '用户不存在');
    }

    const expandedMenuIds = await this.menuService.expandWithParentIds(menuIds || []);

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SysUserMenuEntity, { userId });

      if (expandedMenuIds.length) {
        const values = expandedMenuIds.map((menuId) => ({
          userId,
          menuId,
          status: 1,
        }));
        await manager.insert(SysUserMenuEntity, values);
      }
    });

    await this.clearUserRuntimeCache(userId);
    return ResultData.ok(null, '分配菜单成功');
  }
}
