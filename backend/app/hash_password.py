"""生成 pbkdf2 密码哈希：python -m app.hash_password（配置到 ZZLIB_PASSWORD）。"""
import getpass

from .security import hash_password


def main() -> None:
    password = getpass.getpass("请输入密码：")
    confirm = getpass.getpass("再输入一遍：")
    if password != confirm or not password:
        raise SystemExit("两次输入不一致")
    print("\n将以下内容配置到环境变量 ZZLIB_PASSWORD：\n")
    print(hash_password(password))


if __name__ == "__main__":
    main()
