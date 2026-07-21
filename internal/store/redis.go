package store

import (
	"context"
	"errors"
	"net"

	"github.com/redis/go-redis/v9"
)

type RedisConfig struct {
	Address  string
	Username string
	Password string
	DB       int
}

type Redis struct {
	client *redis.Client
}

func OpenRedis(ctx context.Context, config RedisConfig) (*Redis, error) {
	if _, _, err := net.SplitHostPort(config.Address); err != nil || config.DB < 0 {
		return nil, errors.New("Redis configuration is invalid")
	}
	client := redis.NewClient(&redis.Options{
		Addr: config.Address, Username: config.Username, Password: config.Password, DB: config.DB,
	})
	store := &Redis{client: client}
	if err := store.Ping(ctx); err != nil {
		_ = client.Close()
		return nil, errors.New("Redis is unavailable")
	}
	return store, nil
}

func (store *Redis) Ping(ctx context.Context) error {
	if store == nil || store.client == nil {
		return errors.New("Redis client is unavailable")
	}
	return store.client.Ping(ctx).Err()
}

func (store *Redis) Close() error {
	if store == nil || store.client == nil {
		return nil
	}
	return store.client.Close()
}

func (store *Redis) Client() *redis.Client {
	if store == nil {
		return nil
	}
	return store.client
}
